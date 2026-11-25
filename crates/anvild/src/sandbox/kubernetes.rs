use std::collections::BTreeMap;
use std::path::{Component, Path};
use std::time::Duration;

use k8s_openapi::api::core::v1::{PersistentVolumeClaim, Secret};
use kube::api::{
    ApiResource, DeleteParams, DynamicObject, GroupVersionKind, PostParams, PropagationPolicy,
};
use kube::{Api, Client};
use serde_json::{json, Value};

use super::{
    validate_name, SandboxError, SandboxHandle, SandboxOperation, SandboxProvider, SandboxSpec,
    SERVE_PORT,
};

const MANAGED: &str = "app.kubernetes.io/managed-by";
const API_VERSION: &str = "agents.x-k8s.io/v1beta1";
const WAIT: Duration = Duration::from_secs(120);

pub struct AgentSandboxProvider {
    namespace: String,
    sandboxes: Api<DynamicObject>,
    claims: Api<PersistentVolumeClaim>,
    secrets: Api<Secret>,
}

impl AgentSandboxProvider {
    pub fn new(client: Client, namespace: &str) -> Self {
        let mut resource = ApiResource::from_gvk(&GroupVersionKind::gvk(
            "agents.x-k8s.io",
            "v1beta1",
            "Sandbox",
        ));
        resource.plural = "sandboxes".into();
        Self {
            namespace: namespace.into(),
            sandboxes: Api::namespaced_with(client.clone(), namespace, &resource),
            claims: Api::namespaced(client.clone(), namespace),
            secrets: Api::namespaced(client, namespace),
        }
    }

    async fn ensure_workspace(&self, name: &str) -> Result<(), SandboxError> {
        let claim: PersistentVolumeClaim = serde_json::from_value(json!({
            "metadata": {"name": name, "labels": {MANAGED: "anvil"}},
            "spec": {"accessModes": ["ReadWriteOnce"], "resources": {"requests": {"storage": "5Gi"}}}
        })).expect("static PVC shape");
        let observed = match self.claims.create(&PostParams::default(), &claim).await {
            Ok(created) => created,
            Err(kube::Error::Api(error)) if error.code == 409 => self.claims.get(name).await?,
            Err(error) => return Err(error.into()),
        };
        check_managed(&observed.metadata.labels, name)
    }

    async fn ready(
        &self,
        name: &str,
        mut sandbox: DynamicObject,
    ) -> Result<SandboxHandle, SandboxError> {
        check_managed(&sandbox.metadata.labels, name)?;
        tokio::time::timeout(WAIT, async {
            loop {
                if sandbox.metadata.deletion_timestamp.is_some() {
                    return Err(SandboxError::Kubernetes(format!("{name} is being deleted")));
                }
                let status = &sandbox.data["status"];
                if status["conditions"].as_array().is_some_and(|conditions| {
                    conditions.iter().any(|condition| {
                        condition["type"] == "Ready" && condition["status"] == "True"
                    })
                }) {
                    if let Some(host) = status["serviceFQDN"]
                        .as_str()
                        .filter(|host| !host.is_empty())
                    {
                        return Ok(SandboxHandle {
                            name: name.into(),
                            serve_url: format!("http://{host}:{SERVE_PORT}"),
                        });
                    }
                }
                tokio::time::sleep(Duration::from_millis(300)).await;
                sandbox = self.sandboxes.get(name).await?;
            }
        })
        .await
        .map_err(|_| SandboxError::Unreachable {
            name: name.into(),
            cause: "controller did not publish a ready service within 120 seconds".into(),
        })?
    }

    async fn create(&self, spec: &SandboxSpec) -> Result<SandboxHandle, SandboxError> {
        let (sandbox, mut secret) = resources(spec, &self.namespace)?;
        self.ensure_workspace(&spec.name).await?;
        let sandbox = self
            .sandboxes
            .create(&PostParams::default(), &sandbox)
            .await?;
        let uid = sandbox
            .metadata
            .uid
            .clone()
            .ok_or_else(|| SandboxError::Kubernetes("created Sandbox has no UID".into()))?;
        secret.metadata.owner_references = Some(vec![
            k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference {
                api_version: API_VERSION.into(),
                kind: "Sandbox".into(),
                name: spec.name.clone(),
                uid,
                ..Default::default()
            },
        ]);
        if let Err(error) = self.secrets.create(&PostParams::default(), &secret).await {
            let status = match error {
                kube::Error::Api(response) => format!(" (HTTP {})", response.code),
                _ => String::new(),
            };
            self.remove(&spec.name).await?;
            return Err(SandboxError::Kubernetes(format!(
                "could not provision launch credentials for {}{status}",
                spec.name
            )));
        }
        self.ready(&spec.name, sandbox).await
    }

    async fn remove(&self, name: &str) -> Result<(), SandboxError> {
        validate_resource_name(name)?;
        let Some(sandbox) = self.sandboxes.get_opt(name).await? else {
            return Ok(());
        };
        check_managed(&sandbox.metadata.labels, name)?;
        let mut params = DeleteParams::foreground();
        params.propagation_policy = Some(PropagationPolicy::Foreground);
        params.preconditions = Some(kube::api::Preconditions {
            uid: sandbox.metadata.uid,
            resource_version: None,
        });
        match self.sandboxes.delete(name, &params).await {
            Ok(_) => (),
            Err(kube::Error::Api(error)) if error.code == 404 => return Ok(()),
            Err(error) => return Err(error.into()),
        }
        tokio::time::timeout(WAIT, async {
            while self.sandboxes.get_opt(name).await?.is_some() {
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
            Ok(())
        })
        .await
        .map_err(|_| SandboxError::Kubernetes(format!("deletion of {name} did not finish")))?
    }
}

impl SandboxProvider for AgentSandboxProvider {
    fn start<'a>(&'a self, spec: &'a SandboxSpec) -> SandboxOperation<'a, SandboxHandle> {
        Box::pin(self.create(spec))
    }

    fn handle<'a>(&'a self, name: &'a str) -> SandboxOperation<'a, Option<SandboxHandle>> {
        Box::pin(async move {
            validate_resource_name(name)?;
            match self.sandboxes.get_opt(name).await? {
                Some(sandbox) => self.ready(name, sandbox).await.map(Some),
                None => Ok(None),
            }
        })
    }

    fn destroy<'a>(&'a self, name: &'a str) -> SandboxOperation<'a, ()> {
        Box::pin(self.remove(name))
    }
}

fn validate_resource_name(name: &str) -> Result<(), SandboxError> {
    validate_name(name)?;
    if name.len() > 63 || name.starts_with('-') || name.ends_with('-') {
        return Err(SandboxError::InvalidName { name: name.into() });
    }
    Ok(())
}

fn check_managed(
    labels: &Option<BTreeMap<String, String>>,
    name: &str,
) -> Result<(), SandboxError> {
    if labels
        .as_ref()
        .and_then(|labels| labels.get(MANAGED))
        .map(String::as_str)
        != Some("anvil")
    {
        return Err(SandboxError::Kubernetes(format!(
            "{name} is not managed by Anvil"
        )));
    }
    Ok(())
}

fn resources(spec: &SandboxSpec, namespace: &str) -> Result<(DynamicObject, Secret), SandboxError> {
    validate_resource_name(&spec.name)?;
    let secret_name = format!("{}.launch", spec.name);
    let mut data = spec.env.clone();
    let mut mounts = vec![
        json!({"name": "workspace", "mountPath": "/workspace"}),
        json!({"name": "nix-store", "mountPath": "/nix/store", "readOnly": true}),
        json!({"name": "nix-daemon", "mountPath": "/nix/var/nix/daemon-socket", "readOnly": true}),
    ];
    let mut files = Vec::<Value>::new();
    for (i, (path, content)) in spec.files.iter().enumerate() {
        if path.is_empty()
            || !Path::new(path)
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
        {
            return Err(SandboxError::Kubernetes(format!(
                "invalid launch file path: {path}"
            )));
        }
        let key = format!("file-{i}");
        data.insert(key.clone(), content.clone());
        files.push(json!({"key": key, "path": key}));
        mounts.push(json!({"name": "launch-files", "mountPath": format!("/workspace/{path}"), "subPath": key, "readOnly": true}));
    }
    let mut volumes = vec![
        json!({"name": "workspace", "persistentVolumeClaim": {"claimName": spec.name}}),
        json!({"name": "nix-store", "hostPath": {"path": "/nix/store", "type": "Directory"}}),
        json!({"name": "nix-daemon", "hostPath": {"path": "/nix/var/nix/daemon-socket", "type": "Directory"}}),
    ];
    if !files.is_empty() {
        volumes.push(
            json!({"name": "launch-files", "secret": {"secretName": secret_name, "items": files}}),
        );
    }
    let env: Vec<_> = spec
        .env
        .keys()
        .map(|key| {
            json!({
                "name": key, "valueFrom": {"secretKeyRef": {"name": secret_name, "key": key}}
            })
        })
        .collect();
    let sandbox = serde_json::from_value(json!({
        "apiVersion": API_VERSION, "kind": "Sandbox",
        "metadata": {"name": spec.name, "namespace": namespace, "labels": {MANAGED: "anvil"}},
        "spec": {"service": true, "podTemplate": {
            "metadata": {"labels": {MANAGED: "anvil", "anvil.dev/sandbox": spec.name}},
            "spec": {"automountServiceAccountToken": false, "restartPolicy": "Never",
                "securityContext": {"seccompProfile": {"type": "RuntimeDefault"}},
                "volumes": volumes, "containers": [{
                    "name": "agent", "image": spec.image, "imagePullPolicy": "IfNotPresent",
                    "env": env, "volumeMounts": mounts, "ports": [{"containerPort": SERVE_PORT}],
                    "readinessProbe": {"tcpSocket": {"port": SERVE_PORT}, "periodSeconds": 2},
                    "securityContext": {"allowPrivilegeEscalation": false, "capabilities": {"drop": ["ALL"]}}
                }]
            }
        }}
    })).expect("static Sandbox shape");
    let secret = Secret {
        metadata: kube::api::ObjectMeta {
            name: Some(secret_name),
            namespace: Some(namespace.into()),
            ..Default::default()
        },
        string_data: Some(data),
        ..Default::default()
    };
    Ok((sandbox, secret))
}
