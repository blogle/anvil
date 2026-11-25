use std::collections::BTreeSet;
use std::sync::Mutex;

use anvild::sandbox::{
    validate_name, SandboxHandle, SandboxOperation, SandboxProvider, SandboxSpec,
};

#[derive(Default)]
pub struct TestSandbox(Mutex<BTreeSet<String>>);

fn handle(name: &str) -> SandboxHandle {
    SandboxHandle {
        name: name.into(),
        serve_url: format!("http://{name}/"),
    }
}

impl SandboxProvider for TestSandbox {
    fn start<'a>(&'a self, spec: &'a SandboxSpec) -> SandboxOperation<'a, SandboxHandle> {
        Box::pin(async move {
            validate_name(&spec.name)?;
            tokio::fs::create_dir_all(&spec.workspace).await?;
            for (path, content) in &spec.files {
                let target = spec.workspace.join(path);
                if let Some(parent) = target.parent() {
                    tokio::fs::create_dir_all(parent).await?;
                }
                tokio::fs::write(target, content).await?;
            }
            self.0.lock().unwrap().insert(spec.name.clone());
            Ok(handle(&spec.name))
        })
    }

    fn handle<'a>(&'a self, name: &'a str) -> SandboxOperation<'a, Option<SandboxHandle>> {
        Box::pin(async move {
            validate_name(name)?;
            Ok(self.0.lock().unwrap().contains(name).then(|| handle(name)))
        })
    }

    fn destroy<'a>(&'a self, name: &'a str) -> SandboxOperation<'a, ()> {
        Box::pin(async move {
            validate_name(name)?;
            self.0.lock().unwrap().remove(name);
            Ok(())
        })
    }
}
