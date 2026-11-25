use std::process::ExitCode;

use anvilctl::{attention, done, report, SignalError};

const REPORT_USAGE: &str = "anvilctl report <obligation-id> (--evidence <text> | --clear)";

#[tokio::main]
async fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let Some(command) = args.next() else {
        eprintln!(
            "usage: anvilctl done [--notes <text>] | anvilctl attention <message> | {REPORT_USAGE}"
        );
        return ExitCode::from(2);
    };
    let Ok(base) = std::env::var("ANVILCTL_URL") else {
        eprintln!("anvilctl: ANVILCTL_URL is not set");
        return ExitCode::from(2);
    };
    let Ok(token) = std::env::var("ANVILCTL_TOKEN") else {
        eprintln!("anvilctl: ANVILCTL_TOKEN is not set");
        return ExitCode::from(2);
    };

    let result = match command.as_str() {
        "done" => {
            let mut notes = None;
            let mut rest = args;
            while let Some(flag) = rest.next() {
                match flag.as_str() {
                    "--notes" => {
                        notes = rest.next();
                        if notes.is_none() {
                            eprintln!("anvilctl: --notes needs a value");
                            return ExitCode::from(2);
                        }
                    }
                    other => {
                        eprintln!("anvilctl: unknown flag {other}");
                        return ExitCode::from(2);
                    }
                }
            }
            done(&base, &token, notes.as_deref()).await
        }
        "attention" => {
            let message = args.collect::<Vec<String>>().join(" ");
            if message.is_empty() {
                eprintln!("anvilctl: attention needs a message");
                return ExitCode::from(2);
            }
            attention(&base, &token, &message).await
        }
        "report" => {
            let rest = args.collect::<Vec<_>>();
            match rest.as_slice() {
                [id, flag, evidence] if flag == "--evidence" && !evidence.trim().is_empty() => {
                    report(&base, &token, id, Some(evidence)).await
                }
                [id, flag] if flag == "--clear" => report(&base, &token, id, None).await,
                _ => {
                    eprintln!("usage: {REPORT_USAGE}");
                    return ExitCode::from(2);
                }
            }
        }
        other => {
            eprintln!("anvilctl: unknown command {other}");
            return ExitCode::from(2);
        }
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(SignalError::Rejected) => {
            eprintln!("anvilctl: the daemon rejected this commission token");
            ExitCode::from(1)
        }
        Err(error) => {
            eprintln!("anvilctl: {error}");
            ExitCode::from(1)
        }
    }
}
