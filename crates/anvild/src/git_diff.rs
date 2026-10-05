use serde::Serialize;
use std::{
    io::Read,
    path::Path,
    process::{Command, Stdio},
};

const MAX_FILES: usize = 200;
const MAX_FILE_DIFF: usize = 64 * 1024;
const MAX_RESPONSE_DIFF: usize = 512 * 1024;

#[derive(Debug, Serialize)]
pub struct ChangeSet {
    pub base_revision: String,
    pub files: Vec<FileChange>,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct FileChange {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub additions: Option<usize>,
    pub deletions: Option<usize>,
    pub binary: bool,
    pub too_large: bool,
    pub diff: String,
}

fn git(dir: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| format!("could not run git: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    Ok(output.stdout)
}

fn git_bounded(dir: &Path, args: &[&str], limit: usize) -> Result<(Vec<u8>, bool), String> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not run git: {e}"))?;
    let mut output = Vec::with_capacity(limit.min(8192));
    child
        .stdout
        .take()
        .ok_or_else(|| "git stdout unavailable".to_owned())?
        .take((limit + 1) as u64)
        .read_to_end(&mut output)
        .map_err(|e| e.to_string())?;
    if output.len() > limit {
        let _ = child.kill();
        let _ = child.wait();
        output.truncate(limit + 1);
        return Ok((output, true));
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() && !(args.contains(&"--no-index") && status.code() == Some(1)) {
        return Err("git diff failed".into());
    }
    Ok((output, false))
}

pub fn working_tree_diff(dir: &Path, expected_base: Option<&str>) -> Result<ChangeSet, String> {
    let base = match expected_base {
        Some(base) if !base.is_empty() => base.to_owned(),
        _ => return Err("This session has no recorded worker base revision; its original comparison cannot be established.".into()),
    };
    let pinned = String::from_utf8_lossy(&git(
        dir,
        &["rev-parse", "--verify", "refs/anvil/session-base^{commit}"],
    )?)
    .trim()
    .to_owned();
    if pinned != base {
        return Err(
            "The recorded worker base revision is unavailable or does not match this workspace."
                .into(),
        );
    }
    let (output, too_many_changes) = git_bounded(
        dir,
        &["diff", "--name-status", "-z", "--find-renames", &base, "--"],
        1024 * 1024,
    )?;
    let (untracked, too_many_untracked) = git_bounded(
        dir,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        1024 * 1024,
    )?;
    let mut tokens: Vec<Vec<u8>> = output
        .split(|b| *b == 0)
        .filter(|t| !t.is_empty())
        .map(Vec::from)
        .collect();
    for path in untracked.split(|b| *b == 0).filter(|path| !path.is_empty()) {
        tokens.push(b"A".to_vec());
        tokens.push(path.to_vec());
    }
    let mut changes = Vec::new();
    let mut i = 0;
    let mut truncated = too_many_changes || too_many_untracked;
    let mut response_bytes = 0usize;
    while i < tokens.len() {
        let status = String::from_utf8_lossy(&tokens[i]).to_string();
        i += 1;
        if i >= tokens.len() {
            break;
        }
        let first = String::from_utf8_lossy(&tokens[i]).to_string();
        i += 1;
        let (kind, old_path, path) = if status.starts_with('R') || status.starts_with('C') {
            if i >= tokens.len() {
                break;
            }
            let new = String::from_utf8_lossy(&tokens[i]).to_string();
            i += 1;
            ("renamed".to_owned(), Some(first), new)
        } else {
            let kind = match status.as_str() {
                "A" => "added",
                "D" => "deleted",
                _ => "modified",
            }
            .to_owned();
            (kind, None, first)
        };
        if changes.len() >= MAX_FILES {
            truncated = true;
            break;
        }
        let is_untracked =
            status == "A" && git(dir, &["ls-files", "--error-unmatch", &path]).is_err();
        let patch_args = if is_untracked {
            vec![
                "diff",
                "--no-index",
                "--no-ext-diff",
                "--no-color",
                "--binary",
                "--",
                "/dev/null",
                &path,
            ]
        } else {
            let mut args = vec![
                "diff",
                "--no-ext-diff",
                "--no-color",
                "--find-renames",
                "--binary",
                &base,
                "--",
            ];
            if let Some(old_path) = old_path.as_deref() {
                args.push(old_path);
            }
            args.push(&path);
            args
        };
        let (per_file, file_over_limit) = git_bounded(dir, &patch_args, MAX_FILE_DIFF)?;
        let (additions, deletions) = if is_untracked {
            let count = String::from_utf8_lossy(&per_file)
                .lines()
                .filter(|line| line.starts_with('+') && !line.starts_with("+++"))
                .count();
            (Some(count), Some(0))
        } else {
            let mut numstat_args = vec![
                "diff",
                "--numstat",
                "-z",
                "--find-renames",
                &base,
                "--",
            ];
            if let Some(old_path) = old_path.as_deref() {
                numstat_args.push(old_path);
            }
            numstat_args.push(&path);
            let numstat = git(dir, &numstat_args)?;
            let stat_text = String::from_utf8_lossy(&numstat);
            let mut stat_fields = stat_text.split(['\t', '\0']);
            (
                stat_fields.next().and_then(|v| v.parse().ok()),
                stat_fields.next().and_then(|v| v.parse().ok()),
            )
        };
        let binary = additions.is_none()
            || deletions.is_none()
            || String::from_utf8_lossy(&per_file).contains("GIT binary patch");
        let too_large = file_over_limit
            || (!binary && response_bytes.saturating_add(per_file.len()) > MAX_RESPONSE_DIFF);
        let diff = if binary || too_large {
            String::new()
        } else {
            response_bytes = response_bytes.saturating_add(per_file.len());
            String::from_utf8_lossy(&per_file).into_owned()
        };
        changes.push(FileChange {
            path,
            old_path,
            status: kind,
            additions,
            deletions,
            binary,
            too_large,
            diff,
        });
    }
    let base_revision = String::from_utf8_lossy(&git(
        dir,
        &["rev-parse", "--verify", &format!("{base}^{{commit}}")],
    )?)
    .trim()
    .to_owned();
    Ok(ChangeSet {
        base_revision,
        files: changes,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::Path, process::Command};

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    }

    fn fixture() -> (tempfile::TempDir, String) {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        git(dir, &["init", "-b", "main"]);
        git(dir, &["config", "user.name", "Test"]);
        git(dir, &["config", "user.email", "test@example.com"]);
        fs::write(dir.join("modify.txt"), "base\n").unwrap();
        fs::write(dir.join("delete.txt"), "deleted\n").unwrap();
        fs::write(dir.join("rename-old.txt"), "a line\nb line\nc line\n").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-m", "base"]);
        let base = git(dir, &["rev-parse", "HEAD"]);
        git(dir, &["update-ref", "refs/anvil/session-base", &base]);
        git(dir, &["switch", "-c", "worker"]);
        (tmp, base)
    }

    #[test]
    fn includes_committed_index_and_worktree_changes_and_preserves_recorded_base() {
        let (tmp, base) = fixture();
        let dir = tmp.path();
        git(dir, &["switch", "-c", "upstream", &base]);
        fs::write(dir.join("upstream-only.txt"), "upstream\n").unwrap();
        git(dir, &["add", "upstream-only.txt"]);
        git(dir, &["commit", "-m", "upstream"]);
        let upstream = git(dir, &["rev-parse", "HEAD"]);
        git(dir, &["update-ref", "refs/heads/main", &upstream]);
        git(dir, &["switch", "worker"]);
        fs::write(dir.join("modify.txt"), "committed\n").unwrap();
        git(dir, &["add", "modify.txt"]);
        git(dir, &["commit", "-m", "modify"]);
        fs::write(dir.join("modify.txt"), "committed and uncommitted\n").unwrap();
        fs::write(dir.join("staged.txt"), "staged\n").unwrap();
        git(dir, &["add", "staged.txt"]);
        fs::remove_file(dir.join("delete.txt")).unwrap();
        git(dir, &["mv", "rename-old.txt", "rename-new.txt"]);
        // The default branch moved after base recording, but only its own commit
        // must remain outside the worker diff.
        let result = working_tree_diff(dir, Some(&base)).unwrap();
        assert_eq!(result.base_revision, base);
        let status: std::collections::HashMap<_, _> = result
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.status.as_str()))
            .collect();
        assert_eq!(status.get("modify.txt"), Some(&"modified"));
        assert_eq!(status.get("staged.txt"), Some(&"added"));
        assert_eq!(status.get("delete.txt"), Some(&"deleted"));
        assert_eq!(status.get("rename-new.txt"), Some(&"renamed"));
        let renamed = result
            .files
            .iter()
            .find(|file| file.path == "rename-new.txt")
            .unwrap();
        assert_eq!(renamed.old_path.as_deref(), Some("rename-old.txt"));
        assert!(renamed.diff.contains("rename from rename-old.txt"));
        assert!(renamed.diff.contains("rename to rename-new.txt"));
        assert_eq!(renamed.additions, Some(0));
        assert_eq!(renamed.deletions, Some(0));
        assert!(!status.contains_key("upstream-only.txt"));
        assert!(result
            .files
            .iter()
            .any(|f| f.path == "modify.txt" && f.diff.contains("uncommitted")));
    }

    #[test]
    fn reports_no_change_binary_large_and_missing_base_safely() {
        let (tmp, base) = fixture();
        let dir = tmp.path();
        assert!(working_tree_diff(dir, Some(&base))
            .unwrap()
            .files
            .is_empty());
        assert!(working_tree_diff(dir, None)
            .unwrap_err()
            .contains("no recorded worker base"));
        let wrong_base = "f".repeat(40);
        assert!(working_tree_diff(dir, Some(&wrong_base))
            .unwrap_err()
            .contains("does not match"));
        fs::write(dir.join("image.bin"), [0, 1, 2, 255]).unwrap();
        fs::write(dir.join("huge.txt"), vec![b'x'; 70 * 1024]).unwrap();
        git(dir, &["add", "."]);
        let result = working_tree_diff(dir, Some(&base)).unwrap();
        assert!(result
            .files
            .iter()
            .any(|file| file.path == "image.bin" && file.binary));
        assert!(result
            .files
            .iter()
            .any(|file| file.path == "huge.txt" && file.too_large && file.diff.is_empty()));
    }

    #[test]
    fn suppressed_binary_patches_do_not_consume_returned_diff_budget() {
        let (tmp, base) = fixture();
        let dir = tmp.path();
        for index in 0..100 {
            let bytes = (0..6000)
                .map(|byte| ((byte * 31 + index * 17) % 256) as u8)
                .collect::<Vec<_>>();
            fs::write(dir.join(format!("a-binary-{index:03}.bin")), bytes).unwrap();
        }
        fs::write(dir.join("z-small.txt"), "small change\n").unwrap();
        let result = working_tree_diff(dir, Some(&base)).unwrap();
        let binary = result
            .files
            .iter()
            .find(|file| file.path == "a-binary-000.bin")
            .unwrap();
        assert!(binary.binary);
        let small = result
            .files
            .iter()
            .find(|file| file.path == "z-small.txt")
            .unwrap();
        assert!(!small.too_large);
        assert!(small.diff.contains("small change"));
    }
}
