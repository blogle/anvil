use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Debug, thiserror::Error)]
pub enum AnvilError {
    #[error("the daemon responded {status}: {body}")]
    Api { status: u16, body: String },
    #[error("could not reach the daemon: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("cannot read {path}: {message}")]
    Read { path: String, message: String },
    #[error("invalid yaml in {path}: {message}")]
    Yaml { path: String, message: String },
}

pub struct Anvil {
    base: String,
    client: reqwest::Client,
}

impl Anvil {
    pub fn new(base: impl Into<String>) -> Self {
        Self {
            base: base.into().trim_end_matches('/').to_owned(),
            client: reqwest::Client::new(),
        }
    }

    async fn send(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        idempotency_key: Option<&str>,
        accept: Option<&str>,
    ) -> Result<reqwest::Response, AnvilError> {
        let mut request = self
            .client
            .request(
                method.parse().map_err(|_| AnvilError::Api {
                    status: 0,
                    body: "bad method".to_owned(),
                })?,
                format!("{}{path}", self.base),
            )
            .header("Content-Type", "application/json");
        if let Some(key) = idempotency_key {
            request = request.header("Idempotency-Key", key);
        }
        if let Some(accept) = accept {
            request = request.header("Accept", accept);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            return Err(AnvilError::Api { status, body });
        }
        Ok(response)
    }

    pub fn submission_hash(bytes: &[u8]) -> String {
        let digest = Sha256::digest(bytes);
        let mut hex = String::with_capacity(digest.len() * 2);
        for byte in digest {
            use std::fmt::Write as _;
            let _ = write!(hex, "{byte:02x}");
        }
        hex
    }

    fn read_yaml<T: for<'de> Deserialize<'de>>(path: &std::path::Path) -> Result<T, AnvilError> {
        let text = std::fs::read_to_string(path).map_err(|error| AnvilError::Read {
            path: path.display().to_string(),
            message: error.to_string(),
        })?;
        serde_yaml::from_str(&text).map_err(|error| AnvilError::Yaml {
            path: path.display().to_string(),
            message: error.to_string(),
        })
    }

    pub async fn campaign_submit(
        &self,
        path: &std::path::Path,
    ) -> Result<(Value, bool), AnvilError> {
        let bytes = std::fs::read(path).map_err(|error| AnvilError::Read {
            path: path.display().to_string(),
            message: error.to_string(),
        })?;
        let body: Value = Self::read_yaml(path)?;
        let key = Self::submission_hash(&bytes);
        let response = self
            .send("POST", "/v1/campaigns", Some(body), Some(&key), None)
            .await?;
        let replayed = response.status().as_u16() == 200;
        Ok((response.json().await?, replayed))
    }

    pub async fn commission_add(
        &self,
        campaign: &str,
        path: &std::path::Path,
    ) -> Result<Value, AnvilError> {
        let bytes = std::fs::read(path).map_err(|error| AnvilError::Read {
            path: path.display().to_string(),
            message: error.to_string(),
        })?;
        let body: Value = Self::read_yaml(path)?;
        let key = Self::submission_hash(&bytes);
        let response = self
            .send(
                "POST",
                &format!("/v1/campaigns/{campaign}/commissions"),
                Some(body),
                Some(&key),
                None,
            )
            .await?;
        Ok(response.json().await?)
    }

    pub async fn commissions(&self, campaign: Option<&str>) -> Result<Value, AnvilError> {
        let query = match campaign {
            Some(_) => "?campaign=".to_owned(),
            None => String::new(),
        };
        let _ = query;
        let response = self
            .send("GET", "/v1/commissions", None, None, None)
            .await?;
        Ok(response.json().await?)
    }

    pub async fn status(&self, commission: &str) -> Result<Value, AnvilError> {
        let response = self
            .send(
                "GET",
                &format!("/v1/commissions/{commission}"),
                None,
                None,
                None,
            )
            .await?;
        Ok(response.json().await?)
    }

    pub async fn inbox(&self) -> Result<Value, AnvilError> {
        let response = self.send("GET", "/v1/inbox", None, None, None).await?;
        Ok(response.json().await?)
    }

    pub async fn action(
        &self,
        commission: &str,
        action: &str,
        model: Option<&str>,
    ) -> Result<(), AnvilError> {
        let mut body = json!({"action": action});
        if let Some(model) = model {
            body["model"] = json!(model);
        }
        self.send(
            "POST",
            &format!("/v1/commissions/{commission}"),
            Some(body),
            None,
            None,
        )
        .await?;
        Ok(())
    }

    pub async fn cancel(&self, commission: &str) -> Result<(), AnvilError> {
        self.send(
            "DELETE",
            &format!("/v1/commissions/{commission}"),
            None,
            None,
            None,
        )
        .await?;
        Ok(())
    }

    pub async fn add_obligation(&self, commission: &str, text: &str) -> Result<(), AnvilError> {
        self.send(
            "POST",
            &format!("/v1/commissions/{commission}/obligations"),
            Some(json!({"text": text})),
            None,
            None,
        )
        .await?;
        Ok(())
    }

    pub async fn drop_obligation(&self, obligation: &str) -> Result<(), AnvilError> {
        self.send(
            "DELETE",
            &format!("/v1/obligations/{obligation}"),
            None,
            None,
            None,
        )
        .await?;
        Ok(())
    }

    pub async fn auth_add(&self, name: &str, secret: &str) -> Result<(), AnvilError> {
        self.send(
            "POST",
            "/v1/credentials",
            Some(json!({"name": name, "secret": secret})),
            None,
            None,
        )
        .await?;
        Ok(())
    }

    pub async fn auth_list(&self) -> Result<Value, AnvilError> {
        let response = self
            .send("GET", "/v1/credentials", None, None, None)
            .await?;
        Ok(response.json().await?)
    }

    pub async fn events(&self, since: i64) -> Result<Value, AnvilError> {
        let response = self
            .send(
                "GET",
                &format!("/v1/events?since={since}"),
                None,
                None,
                Some("application/json"),
            )
            .await?;
        Ok(response.json().await?)
    }

    pub async fn events_stream(&self, since: i64) -> Result<reqwest::Response, AnvilError> {
        self.send(
            "GET",
            &format!("/v1/events?since={since}"),
            None,
            None,
            Some("text/event-stream"),
        )
        .await
    }
}

pub fn ps_table(commissions: &Value) -> String {
    let mut out = String::new();
    use std::fmt::Write as _;
    let _ = writeln!(
        out,
        "{:<38} {:<14} {:<5} {:<10} TITLE",
        "COMMISSION", "STATE", "WAVE", "PR"
    );
    for commission in commissions["commissions"].as_array().into_iter().flatten() {
        let id = commission["id"].as_str().unwrap_or("");
        let short = if id.len() > 36 { &id[..36] } else { id };
        let _ = writeln!(
            out,
            "{:<38} {:<14} {:<5} {:<10} {}",
            short,
            commission["state"]["kind"].as_str().unwrap_or(""),
            commission["wave"].as_i64().unwrap_or(0),
            commission["pr_number"]
                .as_i64()
                .map(|n| n.to_string())
                .unwrap_or_default(),
            commission["title"].as_str().unwrap_or(""),
        );
    }
    out
}

pub fn status_view(detail: &Value) -> String {
    let commission = &detail["commission"];
    let mut out = String::new();
    use std::fmt::Write as _;
    let _ = writeln!(
        out,
        "{} ({})",
        commission["title"].as_str().unwrap_or(""),
        commission["slug"].as_str().unwrap_or("")
    );
    let _ = writeln!(
        out,
        "state:    {}",
        commission["state"]["kind"].as_str().unwrap_or("")
    );
    let _ = writeln!(
        out,
        "repo:     {} @ {}",
        commission["repo"].as_str().unwrap_or(""),
        commission["target_ref"].as_str().unwrap_or("")
    );
    let _ = writeln!(
        out,
        "branch:   {}",
        commission["branch"].as_str().unwrap_or("")
    );
    let _ = writeln!(
        out,
        "spec:     {}",
        commission["spec"].as_str().unwrap_or("")
    );
    let _ = writeln!(out, "obligations:");
    for obligation in detail["obligations"].as_array().into_iter().flatten() {
        let _ = writeln!(
            out,
            "  {}. {}",
            obligation["position"].as_i64().unwrap_or(0),
            obligation["text"].as_str().unwrap_or("")
        );
    }
    let _ = writeln!(out, "attempts:");
    for attempt in detail["attempts"].as_array().into_iter().flatten() {
        let ended = if attempt["ended_at"].is_null() {
            "running"
        } else {
            "ended"
        };
        let _ = writeln!(
            out,
            "  #{} {} tokens:{}",
            attempt["n"].as_i64().unwrap_or(0),
            ended,
            attempt["tokens"]
                .as_i64()
                .map(|n| n.to_string())
                .unwrap_or_else(|| "-".to_owned())
        );
    }
    out
}

pub fn inbox_view(inbox: &Value) -> String {
    let mut out = String::new();
    use std::fmt::Write as _;
    let items = inbox["attention"].as_array().cloned().unwrap_or_default();
    if items.is_empty() {
        let _ = writeln!(out, "inbox is clear");
        return out;
    }
    for item in &items {
        let _ = writeln!(
            out,
            "{:<16} {} {}",
            item["kind"].as_str().unwrap_or(""),
            item["commission_id"].as_str().unwrap_or(""),
            item["payload"]["message"].as_str().unwrap_or("")
        );
    }
    out
}

pub fn events_view(events: &Value) -> String {
    let mut out = String::new();
    use std::fmt::Write as _;
    for event in events["events"].as_array().into_iter().flatten() {
        let _ = writeln!(
            out,
            "#{:<5} {} {}",
            event["seq"].as_i64().unwrap_or(0),
            event["kind"].as_str().unwrap_or(""),
            event["commission_id"].as_str().unwrap_or("")
        );
    }
    out
}

pub async fn follow_stream(
    mut response: reqwest::Response,
    stop_after_quiet: Option<std::time::Duration>,
) {
    use std::io::Write as _;
    let mut parser = SseLines::default();
    let quiet = stop_after_quiet.unwrap_or(std::time::Duration::from_secs(0));
    let mut last_frame = std::time::Instant::now();
    loop {
        let chunk = tokio::time::timeout(std::time::Duration::from_millis(500), response.chunk())
            .await
            .ok()
            .and_then(|result| result.ok().flatten());
        let Some(chunk) = chunk else {
            if !quiet.is_zero() && last_frame.elapsed() > quiet {
                return;
            }
            continue;
        };
        parser.feed(&chunk);
        while let Some(line) = parser.next_line() {
            last_frame = std::time::Instant::now();
            let mut stdout = std::io::stdout().lock();
            let _ = writeln!(stdout, "{line}");
            let _ = stdout.flush();
        }
    }
}

#[derive(Default)]
struct SseLines {
    buffer: String,
}

impl SseLines {
    fn feed(&mut self, bytes: &[u8]) {
        self.buffer
            .push_str(&String::from_utf8_lossy(bytes).replace("\r\n", "\n"));
    }

    fn next_line(&mut self) -> Option<String> {
        loop {
            let line_end = self.buffer.find('\n')?;
            let line: String = self.buffer.drain(..=line_end).collect();
            let line = line.trim_end().to_owned();
            if let Some(data) = line.strip_prefix("data: ") {
                if let Ok(value) = serde_json::from_str::<Value>(data) {
                    return Some(format!(
                        "#{:<5} {} {}",
                        value["seq"].as_i64().unwrap_or(0),
                        value["kind"].as_str().unwrap_or(""),
                        value["commission_id"].as_str().unwrap_or("")
                    ));
                }
            }
        }
    }
}
