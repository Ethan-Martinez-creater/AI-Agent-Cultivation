# GEN_HTTP_V1

Version 1 is the application-owned HTTP contract for a self-hosted generation service. It is independent of the legacy H3 protocol. Select `GEN_HTTP_V1` when creating a new fixed generation identity; existing `H3` identities remain unchanged.

## Transport

The configured base URL may end in `/v1`; the adapter removes this suffix before adding the fixed paths below. Bearer authentication, if configured, is sent only to that origin. Redirects are refused. JSON responses are bounded to 256 KiB. No response supplies an executable request template, filesystem path, or download host.

Main sends generation writes through a single Node HTTP/HTTPS request, without automatic retries or connection pooling. Electron selects the proxy; DIRECT and unauthenticated HTTP proxies (HTTPS origin via verified TLS/CONNECT) are supported. Other proxy modes fail closed. Read-only requests retain Electron networking. A lost accepted POST response stays UNKNOWN even when the Provider could deduplicate a repeated request.

| Method | Path                                               | Contract                                                                 |
| ------ | -------------------------------------------------- | ------------------------------------------------------------------------ |
| GET    | `/health`                                          | `{ "status": "ok" }`                                                     |
| GET    | `/v1/models`                                       | `{ "protocol": "GEN_HTTP_V1", "models": [GenerationModelDescriptor] }`   |
| POST   | `/v1/files`                                        | Streaming media body; response `{fileId,mimeType,sizeBytes,contentHash}` |
| POST   | `/v1/generations`                                  | One billable logical submission; response `{providerJobId,status}`       |
| GET    | `/v1/generations/{id}`                             | `{providerJobId,status,outputs,errorCode}`                               |
| GET    | `/v1/generations/{id}/outputs/{outputId}/download` | Streaming binary, matching Content-Type and optional Content-Length      |

Model descriptors use the provider-neutral Generation domain fields: modelId, outputCapability, executionMode, featureTags, inputRoles, parameterSchema, outputTypes and limits. Capability is separate from featureTags. Image, video, music and speech capabilities share this contract. The bounded parameter schema supports object properties, scalar/array types, enums and numeric/length limits; remote references and executable validators are forbidden. Main applies both descriptor limits and the application media safety ceilings.

## Trusted Artifact input

Upload headers are `X-Artifact-Id`, `X-Input-Role`, `X-Content-Sha256`, `X-Content-Size`, `Content-Type`, and `Idempotency-Key: <task>:<artifact>:<role>`. Main resolves Artifact identity and authorizes reading before the adapter receives a readable source. The adapter incrementally verifies uploaded size/hash. The service must return matching metadata and a stable fileId. File upload is not a generation submission.

The generation body is `{model,capability,requiredFeatures,prompt,inputs,parameters}`. Each input is `{fileId,artifactId,role,contentHash}`. No software path or additional authority is included. `Idempotency-Key` is exactly GenerationTask.id.

## Submission and recovery

The adapter persists PREPARED and the exact request body, then SUBMITTING before sending the billable POST. A successful response must contain a bounded providerJobId and QUEUED or RUNNING. The server must enforce same-key/same-request idempotency and reject a changed request fingerprint. Main never uses this guarantee as permission to replay an uncertain submission.

An unsuccessful response is definitive only when its stable body includes `error.accepted=false` and a recognized error.code: AUTH_FAILED, MODEL_NOT_FOUND, INVALID_INPUT, UNSUPPORTED_FEATURE, UNSUPPORTED_INPUT_ROLE, MODEL_DURATION_LIMIT, QUEUE_FULL or IDEMPOTENCY_CONFLICT. Otherwise the adapter records UNKNOWN. A durable SUBMITTING record discovered after process loss also becomes UNKNOWN without another POST. SUBMITTED uses the original providerJobId; UNKNOWN and REJECTED are never automatically resubmitted.

Task status is QUEUED / RUNNING / COMPLETED / FAILED / CANCELLED / UNKNOWN. A completed task must have a nonempty bounded output manifest. Each output is `{id,mimeType,extension,sizeBytes,contentHash,metadata}`. Main validates metadata, incremental SHA-256 and streamed length before media validation and atomic Artifact registration. Provider COMPLETED alone never completes the software Job.

## Deployment boundary

The independent offline HTTP fixture exercises the production adapter. A future self-hosted H3 service must implement this contract and be live-tested separately. No H3 GPU live result is claimed in this release.
