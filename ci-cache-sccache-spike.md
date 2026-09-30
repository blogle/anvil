# CI cache and sccache spike

## Baseline (main, 2026-09-29)

Captured from GitHub Actions before this spike, on `28c1acca`:

| Lane | Run | Elapsed | Dominant work |
| --- | --- | ---: | --- |
| Local-first E2E harness (push) | [36639826396](https://github.com/blogle/anvil/actions/runs/36639826396) | 13m47s | Rust checks 9m46s; process E2E 2m07s; sandbox OCI acceptance 1m44s |
| Image publish (push) | [36639826372](https://github.com/blogle/anvil/actions/runs/36639826372) | 32m49s | Nix checks 6m21s; production images 23m29s; publish 2m38s |
| PR image build | [36639177702](https://github.com/blogle/anvil/actions/runs/36639177702) | 25m49s for image artifact job | Flake validation 22s; OCI/archive build 24m32s; artifacts 39s |
| PR E2E harness | [36639177735](https://github.com/blogle/anvil/actions/runs/36639177735) | 13m50s | Rust checks and process/sandbox acceptance |

The PR image run's Kind lane failed after 5m36s, so its 35m total workflow
duration is not a successful required-check baseline. The successful PR
comparison [36621994590](https://github.com/blogle/anvil/actions/runs/36621994590)
and [36621994667](https://github.com/blogle/anvil/actions/runs/36621994667)
completed in 28m03s and 14m43s respectively (parallel required lanes).

## Spike design

* Nix image cache retains only the recursive closure of
  `.#anvil-image-ci` and `.#anvil-ci-release-cargo-artifacts`, which are
  Anvil-owned roots already used by PR OCI construction. It does not snapshot
  the generic Nix store. `cache-nar-bytes` measures the candidate closure;
  export/save is skipped above 2 GiB. GitHub's repository cache quota/eviction
  remains 10 GiB total.
* Cache key includes OS, `flake.lock`, `Cargo.lock`, and source/build inputs.
  A dependency/toolchain change misses the dependency prefix; a source-only
  change may restore the latest compatible prefix. Exact keys are immutable.
* PR cache reads use `actions/cache/restore`; PR snapshots are written under
  GitHub's pull-request merge-ref cache scope. GitHub cache access rules prevent
  those entries from being restored by main or other PR refs. No PR job receives
  a token or network route to private infrastructure. The image cache save time
  is reported by the cache action's post-job timing; local import/export and NAR
  size are included in `image-build-timings.txt`.
* `sccache` is enabled only around the hosted CI Cargo checks through the
  GitHub Actions cache backend. It is not enabled inside Crane derivations or
  production image builds: those remain pure/reproducible Nix builds. The cache
  key includes sccache's compiler/toolchain identity; PR refs cannot write the
  default-branch cache. Stats are printed after Rust checks.

## Experimental evidence

Fill this section from the spike branch Actions runs before recommending a
merge. Record both cold and same-PR warm runs, and include job/step timings,
cache restore/save, image build realization, Rust compile duration and sccache
hit/miss counts. Do not interpret a cache miss as a validation failure.

| Run | Scenario | Required-check wall time | Nix restore/save | Rust compile / sccache | Result |
| --- | --- | ---: | --- | --- | --- |
| Pending | Cold | | | | |
| Pending | Warm, unchanged deps | | | | |
| Pending | Source-only commit | | | | |

## Recommendation

Pending measured runs. Evaluate the bounded image closure and sccache
independently; abandon either if restore/save cost exceeds the work it saves.
