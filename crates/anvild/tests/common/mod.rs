use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread;

use serde_json::Value;

pub const TEST_PEM: &str = include_str!("../test-github-app.pem");

pub type Handler = Box<dyn Fn(&str, &str, &Value) -> (u16, String) + Send>;

pub struct MockGithub {
    addr: std::net::SocketAddr,
    requests: mpsc::Receiver<String>,
    _handle: thread::JoinHandle<()>,
}

impl MockGithub {
    pub fn spawn(handler: Handler) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, requests) = mpsc::channel();
        let handle = thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut buffer = String::new();
                let mut buf = [0u8; 8192];
                loop {
                    let n = stream.read(&mut buf).unwrap();
                    buffer.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if let Some(head_end) = buffer.find("\r\n\r\n") {
                        let length = buffer[head_end..].len().saturating_sub(4);
                        let content_length = buffer
                            .split("\r\n")
                            .find_map(|line| {
                                line.strip_prefix("Content-Length: ")
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if length >= content_length {
                            break;
                        }
                    }
                    if n == 0 {
                        break;
                    }
                }
                let head = buffer.split("\r\n\r\n").next().unwrap_or_default();
                let mut lines = head.splitn(2, ' ');
                let method = lines.next().unwrap_or_default().to_owned();
                let rest = lines.next().unwrap_or_default();
                let path = rest.split(' ').next().unwrap_or_default().to_owned();
                let body_text = buffer
                    .split_once("\r\n\r\n")
                    .map(|(_, body)| body.to_owned())
                    .unwrap_or_default();
                let body: Value = serde_json::from_str(&body_text).unwrap_or(Value::Null);
                tx.send(format!("{method} {path}")).unwrap();
                let (status, body) = handler(&method, &path, &body);
                let reason = if status < 300 { "OK" } else { "Error" };
                let response = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        Self {
            addr,
            requests,
            _handle: handle,
        }
    }

    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub fn next_request(&self) -> String {
        self.requests
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
    }
}

pub fn client(url: &str) -> anvild::github::GithubClient {
    anvild::github::GithubClient::new(url, "test-app", 1, TEST_PEM).unwrap()
}
