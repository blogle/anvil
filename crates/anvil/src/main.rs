use std::process::ExitCode;

use anvil::{Anvil, AnvilError};
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "anvil", about = "operator client for the anvil daemon")]
struct Cli {
    #[arg(long, global = true)]
    url: Option<String>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Campaign {
        #[command(subcommand)]
        verb: CampaignVerb,
    },
    Commission {
        #[command(subcommand)]
        verb: CommissionVerb,
    },
    Ps {
        #[arg(long)]
        json: bool,
    },
    Status {
        id: String,
        #[arg(long)]
        json: bool,
    },
    Logs {
        id: String,
        #[arg(long)]
        follow: bool,
        #[arg(long, default_value_t = 0)]
        since: i64,
    },
    Inbox {
        #[arg(long)]
        json: bool,
    },
    Retry {
        id: String,
    },
    Resume {
        id: String,
    },
    Takeover {
        id: String,
    },
    Cancel {
        id: String,
    },
    Revise {
        id: String,
        #[arg(long)]
        add_obligation: Option<String>,
        #[arg(long)]
        drop_obligation: Option<String>,
    },
    Auth {
        #[command(subcommand)]
        verb: AuthVerb,
    },
}

#[derive(Subcommand)]
enum CampaignVerb {
    Submit { file: String },
}

#[derive(Subcommand)]
enum CommissionVerb {
    Add { campaign: String, file: String },
}

#[derive(Subcommand)]
enum AuthVerb {
    Add {
        name: String,
        #[arg(long)]
        secret: Option<String>,
    },
    List,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let base = cli
        .url
        .or_else(|| std::env::var("ANVIL_URL").ok())
        .unwrap_or_else(|| "http://127.0.0.1:8788".to_owned());
    let anvil = Anvil::new(base);

    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("anvil: cannot start the runtime: {error}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(run(anvil, cli.command)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("anvil: {error}");
            ExitCode::from(1)
        }
    }
}

async fn run(anvil: Anvil, command: Command) -> Result<(), AnvilError> {
    match command {
        Command::Campaign {
            verb: CampaignVerb::Submit { file },
        } => {
            let path = std::path::PathBuf::from(&file);
            let (campaign, replayed) = anvil.campaign_submit(&path).await?;
            if replayed {
                println!("campaign already submitted (content hash matched)");
            }
            println!("{}", serde_json::to_string_pretty(&campaign).unwrap());
        }
        Command::Commission {
            verb: CommissionVerb::Add { campaign, file },
        } => {
            let path = std::path::PathBuf::from(&file);
            let commission = anvil.commission_add(&campaign, &path).await?;
            println!("{}", serde_json::to_string_pretty(&commission).unwrap());
        }
        Command::Ps { json } => {
            let commissions = anvil.commissions(None).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&commissions).unwrap());
            } else {
                print!("{}", anvil::ps_table(&commissions));
            }
        }
        Command::Status { id, json } => {
            let detail = anvil.status(&id).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&detail).unwrap());
            } else {
                print!("{}", anvil::status_view(&detail));
            }
        }
        Command::Logs {
            id: _,
            follow,
            since,
        } => {
            if follow {
                let response = anvil.events_stream(since).await?;
                anvil::follow_stream(response, None).await;
            } else {
                let events = anvil.events(since).await?;
                print!("{}", anvil::events_view(&events));
            }
        }
        Command::Inbox { json } => {
            let inbox = anvil.inbox().await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&inbox).unwrap());
            } else {
                print!("{}", anvil::inbox_view(&inbox));
            }
        }
        Command::Retry { id } => anvil.action(&id, "retry").await?,
        Command::Resume { id } => anvil.action(&id, "resume").await?,
        Command::Takeover { id } => anvil.action(&id, "takeover").await?,
        Command::Cancel { id } => anvil.cancel(&id).await?,
        Command::Revise {
            id,
            add_obligation,
            drop_obligation,
        } => {
            if let Some(text) = add_obligation {
                anvil.add_obligation(&id, &text).await?;
            }
            if let Some(obligation) = drop_obligation {
                anvil.drop_obligation(&obligation).await?;
            }
        }
        Command::Auth { verb } => match verb {
            AuthVerb::Add { name, secret } => {
                let secret = match secret {
                    Some(secret) => secret,
                    None => {
                        let mut buffer = String::new();
                        if std::io::Read::read_to_string(&mut std::io::stdin(), &mut buffer)
                            .is_err()
                            || buffer.trim().is_empty()
                        {
                            eprintln!("anvil: provide the secret via --secret or stdin");
                            return Ok(());
                        }
                        buffer.trim_end_matches('\n').to_owned()
                    }
                };
                anvil.auth_add(&name, &secret).await?;
                println!("credential {name} stored");
            }
            AuthVerb::List => {
                let credentials = anvil.auth_list().await?;
                for credential in credentials["credentials"].as_array().into_iter().flatten() {
                    println!("{}", credential["name"].as_str().unwrap_or(""));
                }
            }
        },
    }
    Ok(())
}
