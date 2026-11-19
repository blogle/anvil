use std::collections::{BTreeMap, VecDeque};
use std::sync::Mutex;

use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq)]
pub struct TurnReceipt {
    pub session: String,
    pub tokens: Option<i64>,
}

#[derive(Debug, thiserror::Error)]
pub enum HarnessError {
    #[error("credential {name} not found in the store")]
    CredentialMissing { name: String },
    #[error("opencode responded {status}: {body}")]
    BadStatus { status: u16, body: String },
    #[error("opencode response lacked the field {field}")]
    Malformed { field: &'static str },
    #[error("scripted harness ran out of scripted turns")]
    ScriptExhausted,
    #[error(transparent)]
    Transport(#[from] reqwest::Error),
}

#[derive(Debug, Clone, Default)]
pub struct ProviderConfig {
    pub files: BTreeMap<String, String>,
    pub env: BTreeMap<String, String>,
}

pub fn materialize_provider_config(
    strategy: &Value,
    credentials: &BTreeMap<String, String>,
) -> Result<ProviderConfig, HarnessError> {
    let mut config = json!({});
    if let Some(model) = strategy.get("model").and_then(Value::as_str) {
        config["model"] = json!(model);
    }
    if let Some(mcp) = strategy.get("mcp") {
        config["mcp"] = mcp.clone();
    }
    let mut files = BTreeMap::new();
    files.insert("opencode.json".to_owned(), config.to_string());

    let mut env = BTreeMap::new();
    for name in strategy
        .get("credentials")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(name) = name.as_str() else {
            return Err(HarnessError::Malformed {
                field: "credentials entry",
            });
        };
        let Some(secret) = credentials.get(name) else {
            return Err(HarnessError::CredentialMissing {
                name: name.to_owned(),
            });
        };
        env.insert(name.to_owned(), secret.clone());
    }
    Ok(ProviderConfig { files, env })
}

pub enum Harness {
    Opencode(OpencodeHarness),
    Scripted(ScriptedHarness),
}

impl Harness {
    pub async fn run_turn(
        &self,
        session: Option<&str>,
        prompt: &str,
    ) -> Result<TurnReceipt, HarnessError> {
        match self {
            Self::Opencode(harness) => harness.run_turn(session, prompt).await,
            Self::Scripted(harness) => harness.run_turn(session, prompt).await,
        }
    }
}

pub struct OpencodeHarness {
    base: String,
    client: reqwest::Client,
}

impl OpencodeHarness {
    pub fn new(base: impl Into<String>) -> Self {
        Self {
            base: base.into(),
            client: reqwest::Client::new(),
        }
    }

    pub async fn run_turn(
        &self,
        session: Option<&str>,
        prompt: &str,
    ) -> Result<TurnReceipt, HarnessError> {
        let (id, before) = match session {
            Some(id) => {
                let info = self.session_info(id).await?;
                (id.to_owned(), tokens_total(&info))
            }
            None => {
                let info = self
                    .post_json("/api/session", &json!({"title": "anvil"}))
                    .await?;
                let data = field(&info, "data")?;
                (field_str(data, "id")?.to_owned(), tokens_total(data))
            }
        };
        self.post_json(
            &format!("/api/session/{id}/prompt"),
            &json!({"text": prompt}),
        )
        .await?;
        self.wait(&id).await?;
        let info = self.session_info(&id).await?;
        let spent = tokens_total(field(&info, "data")?).saturating_sub(before);
        Ok(TurnReceipt {
            session: id,
            tokens: Some(spent),
        })
    }

    pub async fn subscribe(&self, types: &[&str]) -> Result<EventStream, HarnessError> {
        let response = self
            .client
            .get(format!("{}/api/event", self.base))
            .query(&[("types", types.join(","))])
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            return Err(HarnessError::BadStatus {
                status: status.as_u16(),
                body: String::new(),
            });
        }
        Ok(EventStream {
            response,
            parser: SseParser::default(),
        })
    }

    async fn session_info(&self, id: &str) -> Result<Value, HarnessError> {
        let response = self
            .client
            .get(format!("{}/api/session/{id}", self.base))
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            return Err(HarnessError::BadStatus {
                status: status.as_u16(),
                body: response.text().await.unwrap_or_default(),
            });
        }
        Ok(response.json().await?)
    }

    async fn wait(&self, id: &str) -> Result<(), HarnessError> {
        let response = self
            .client
            .post(format!("{}/api/experimental/session/{id}/wait", self.base))
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(HarnessError::BadStatus {
                status: response.status().as_u16(),
                body: response.text().await.unwrap_or_default(),
            });
        }
        Ok(())
    }

    async fn post_json(&self, path: &str, body: &Value) -> Result<Value, HarnessError> {
        let response = self
            .client
            .post(format!("{}{path}", self.base))
            .json(body)
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            return Err(HarnessError::BadStatus {
                status: status.as_u16(),
                body: response.text().await.unwrap_or_default(),
            });
        }
        Ok(response.json().await?)
    }
}

fn field<'a>(value: &'a Value, name: &'static str) -> Result<&'a Value, HarnessError> {
    value
        .get(name)
        .ok_or(HarnessError::Malformed { field: name })
}

fn field_str<'a>(value: &'a Value, name: &'static str) -> Result<&'a str, HarnessError> {
    value
        .get(name)
        .and_then(Value::as_str)
        .ok_or(HarnessError::Malformed { field: name })
}

fn tokens_total(info: &Value) -> i64 {
    let tokens = info.get("tokens");
    let read = |name: &str| {
        tokens
            .and_then(|t| t.get(name))
            .and_then(Value::as_i64)
            .unwrap_or(0)
    };
    let cache = |name: &str| {
        tokens
            .and_then(|t| t.get("cache"))
            .and_then(|c| c.get(name))
            .and_then(Value::as_i64)
            .unwrap_or(0)
    };
    read("input") + read("output") + read("reasoning") + cache("read") + cache("write")
}

#[derive(Debug, Clone, PartialEq)]
pub struct HarnessEvent {
    pub kind: String,
    pub properties: Value,
}

pub struct EventStream {
    response: reqwest::Response,
    parser: SseParser,
}

impl EventStream {
    pub async fn next_event(&mut self) -> Option<Result<HarnessEvent, HarnessError>> {
        loop {
            if let Some(frame) = self.parser.next_frame() {
                return Some(harness_event(&frame));
            }
            let chunk = match self.response.chunk().await {
                Ok(chunk) => chunk?,
                Err(error) => return Some(Err(error.into())),
            };
            self.parser.feed(&chunk);
        }
    }
}

fn harness_event(frame: &SseFrame) -> Result<HarnessEvent, HarnessError> {
    let data: Value = serde_json::from_str(&frame.data).map_err(|_| HarnessError::Malformed {
        field: "event data",
    })?;
    let kind = frame
        .event
        .clone()
        .or_else(|| data.get("type").and_then(Value::as_str).map(str::to_owned))
        .ok_or(HarnessError::Malformed {
            field: "event type",
        })?;
    let properties = data.get("properties").cloned().unwrap_or(data);
    Ok(HarnessEvent { kind, properties })
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct SseFrame {
    pub event: Option<String>,
    pub data: String,
}

#[derive(Default)]
pub struct SseParser {
    buffer: String,
}

impl SseParser {
    pub fn feed(&mut self, bytes: &[u8]) {
        let text = String::from_utf8_lossy(bytes);
        self.buffer.push_str(&text.replace("\r\n", "\n"));
    }

    pub fn next_frame(&mut self) -> Option<SseFrame> {
        loop {
            let end = self.buffer.find("\n\n")?;
            let block = self.buffer[..end].to_owned();
            self.buffer.drain(..end + 2);

            let mut frame = SseFrame::default();
            let mut data: Vec<&str> = Vec::new();
            for line in block.split('\n') {
                let Some((field, value)) = line.split_once(':') else {
                    continue;
                };
                let value = value.strip_prefix(' ').unwrap_or(value);
                match field {
                    "event" => frame.event = Some(value.to_owned()),
                    "data" => data.push(value),
                    _ => {}
                }
            }
            frame.data = data.join("\n");
            if frame.event.is_some() || !frame.data.is_empty() {
                return Some(frame);
            }
        }
    }
}

pub struct ScriptedHarness {
    script: Mutex<VecDeque<Result<TurnReceipt, HarnessError>>>,
    pub received: Mutex<Vec<(Option<String>, String)>>,
}

impl ScriptedHarness {
    pub fn new(script: Vec<Result<TurnReceipt, HarnessError>>) -> Self {
        Self {
            script: Mutex::new(script.into_iter().collect()),
            received: Mutex::new(Vec::new()),
        }
    }

    pub async fn run_turn(
        &self,
        session: Option<&str>,
        prompt: &str,
    ) -> Result<TurnReceipt, HarnessError> {
        self.received
            .lock()
            .unwrap()
            .push((session.map(str::to_owned), prompt.to_owned()));
        self.script
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Err(HarnessError::ScriptExhausted))
    }
}
