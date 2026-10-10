# Shared Nix volume ownership

## Finding

The mutation is initiated by Pod-level `fsGroup` handling, not by a process in
the sandbox container. `sandbox_manifest` in `crates/anvild/src/lib.rs` put
`fsGroup: 1000` on each Agent Sandbox Pod template. Agent Sandbox copied that
field into the live Pod. The sandbox volume mounts were read-only bind mounts,
but the PVC source itself was published read-write.

Live cluster evidence on 2026-10-09:

- The five existing Anvil Sandbox custom resources and their Pods had
  `spec.securityContext.fsGroup: 1000`.
- `anvil-nix-shared` is an RWO PVC using `openebs-zfspv-shared-ext4`; its PV
  reports `fsType: ext4` and provisioner `zfs.csi.openebs.io`.
- The installed `CSIDriver` reports
  `fsGroupPolicy: ReadWriteOnceWithFSType`, which makes this RWO filesystem
  eligible for Kubernetes fsGroup ownership handling.
- The OpenEBS NodePublishVolume request for the shared PVC did not contain a
  CSI `volume_mount_group`; ownership handling therefore occurred in kubelet's
  volume setup path, before the container started.
- The running PVC had `/nix`, `/nix/var`, `/nix/var/nix`, and
  `/nix/var/nix/builds` at `0:1000 2775`. The daemon entrypoint had previously
  normalized the build directories to `0:0 0755` during its startup.

During investigation, a temporary PVC on that OpenEBS StorageClass reproduced
the same transition: `fsGroup: 1000` changed the PVC from `0:0 0755` to
`0:1000 2775`, and a fresh derivation failed when GNU `chmod 0700 source`
attempted to change an inherited-`2755` directory. That live-cluster experiment
is not kept as a repository test. The persistent CI guard is the existing Kind
acceptance: it creates Sandboxes through Anvil's API, asserts their generated
Pod templates omit fsGroup, and runs fresh derivations across Sandbox lifecycle
transitions. Kind's local-path storage does not reproduce the OpenEBS ownership
pass; the explicit manifest assertion makes reintroducing fsGroup fail CI,
while the uncached builds ensure the corrected configuration remains usable.

Kubernetes documents that fsGroup volume ownership changes happen during
volume setup, and that CSI may take responsibility when it advertises the
corresponding mount capability. The live CSIDriver policy and NodePublish
request establish that the kubelet path applies here. The mutation therefore
happened after daemon startup whenever a sandbox Pod mounted the PVC. The
daemon's earlier chmods could not prevent a later kubelet ownership pass.

Nix builders run without capabilities and with `NoNewPrivs` and seccomp
filtering. In the observed builder, a directory created under the setgid
builds parent inherited mode `2755`; chmod's numeric-mode request retained
setgid (`fchmodat(..., 02700)`) and Nix rejected it. Clearing setgid first
allowed chmod, but the architecture fix is to stop applying fsGroup to the
shared PVC. Nix syscall filtering remains enabled.

## Ownership boundary

- The daemon owns `/nix` and remains the only writer to the Nix store.
- Sandbox Pods have no Pod-level fsGroup. Their workspace PVC is separately
  initialized to UID/GID 1000, and the shared OpenCode profile PVC is prepared
  by the profile workload.
- Sandbox client mounts for `/nix/store` and the daemon socket remain
  container-level read-only mounts. Do not set `readOnly: true` on the shared
  PVC source: OpenEBS cannot concurrently publish this RWO ext4 ZVOL
  read-write to the daemon and read-only to another Pod; the investigation's
  disposable PVC received `not able to format and mount the zvol`.
- Nix builds continue through the daemon socket. No privilege, builder filter,
  or sandbox bypass is added.

## Existing-PVC recovery

The current production PVC has stale fsGroup metadata. Correct the
configuration first so new Sandbox Pods no longer request ownership changes.
Existing Sandbox custom resources retain their old Pod template, however; the
live ANVIL-55/56 and other existing sessions must be drained or explicitly
migrated to templates without fsGroup before recovery. Do not run the recovery
while any old-template sandbox may remount the PVC. Then pause new sandbox
creation and ensure the daemon is available. Capture the current `stat` output
and database size for rollback evidence. Apply this bounded, non-recursive
operation once through the daemon container:

```sh
chown root:root /nix /nix/var /nix/var/nix /nix/var/nix/builds
chmod 0755 /nix /nix/var /nix/var/nix /nix/var/nix/builds
```

Validate the same four paths are `0:0 0755`, `nix store info` succeeds, the
Nix database remains present, and a fresh uncached derivation builds. This
does not traverse or modify `/nix/store`, the database file, GC roots, or
derivation contents.

If the new daemon cannot start and the release must be rolled back, restore
only the captured ownership/modes for those four directories; the previous
daemon startup normalization can then start the old release. That rollback
restores the failure condition and must not be treated as the permanent fix.

The daemon entrypoint now validates protected directory metadata instead of
repairing populated PVCs on every startup. It only secures the root of a
truly uninitialized PVC for compatibility with Kind's local-path provisioner.
