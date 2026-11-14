use std::sync::RwLock;

use aws_emulator_embedded::{Authentication, AwsEmulatorEmbedded, EmbeddedOptions, Telemetry};
use aws_smithy_runtime_api::client::http::{HttpConnector, SharedHttpConnector};
use aws_smithy_runtime_api::client::orchestrator::HttpRequest;
use aws_smithy_types::body::SdkBody;
use aws_smithy_types::byte_stream::ByteStream;
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Stack for assembling the router. Building it walks every service's declaration, which
/// overflows a default-sized thread; upstream's own boot checks use the same size.
const BOOT_STACK_SIZE: usize = 64 * 1024 * 1024;

/// Stack for the tokio workers that run requests. Some handlers (CloudFormation,
/// Step Functions, Lambda runtimes) recurse deeply, so the 2 MiB tokio default is not enough.
const WORKER_STACK_SIZE: usize = 32 * 1024 * 1024;

#[napi_derive::module_init]
fn init() {
  let runtime = tokio::runtime::Builder::new_multi_thread()
    .enable_all()
    .thread_name("aws-emulator")
    .thread_stack_size(WORKER_STACK_SIZE)
    .build()
    .expect("build the aws-emulator tokio runtime");
  create_custom_tokio_runtime(runtime);
}

#[napi(object)]
#[derive(Default)]
pub struct NativeEmulatorOptions {
  /// Require every request to be SigV4-signed with the credentials this emulator vends.
  /// Default: `false`.
  pub authentication: Option<bool>,
  /// Usage telemetry (process-wide; `false` from any emulator wins). Default: `true`,
  /// matching upstream. `EMULATOR_TELEMETRY=off` also turns it off.
  pub telemetry: Option<bool>,
}

#[napi(object)]
pub struct NativeHeader {
  pub name: String,
  pub value: String,
}

#[napi(object)]
pub struct NativeRequest {
  pub method: String,
  /// The absolute URL the SDK would have called, e.g. `https://s3.us-east-1.amazonaws.com/b/k`.
  pub url: String,
  pub headers: Vec<NativeHeader>,
  pub body: Option<Buffer>,
}

#[napi(object)]
pub struct NativeResponse {
  pub status: u16,
  pub headers: Vec<NativeHeader>,
  pub body: Buffer,
}

#[napi(object)]
pub struct NativeCredentials {
  pub access_key_id: String,
  pub secret_access_key: String,
}

/// One in-process emulator with its own, fresh in-memory state.
#[napi]
pub struct NativeEmulator {
  inner: RwLock<Option<AwsEmulatorEmbedded>>,
}

#[napi]
impl NativeEmulator {
  #[napi(constructor)]
  pub fn new(options: Option<NativeEmulatorOptions>) -> Result<Self> {
    let options = options.unwrap_or_default();
    let mut embedded = EmbeddedOptions::default();
    if options.authentication.unwrap_or(false) {
      embedded = embedded.authentication(Authentication::On);
    }
    if !options.telemetry.unwrap_or(true) {
      embedded = embedded.telemetry(Telemetry::Off);
    }

    let emulator = std::thread::Builder::new()
      .name("aws-emulator-boot".to_owned())
      .stack_size(BOOT_STACK_SIZE)
      .spawn(move || AwsEmulatorEmbedded::new(embedded))
      .map_err(|e| Error::from_reason(format!("failed to spawn the boot thread: {e}")))?
      .join()
      .map_err(|_| Error::from_reason("the emulator panicked while booting"))?;

    Ok(Self {
      inner: RwLock::new(Some(emulator)),
    })
  }

  /// Whether [`Self::close`] has been called.
  #[napi(getter)]
  pub fn closed(&self) -> bool {
    self.read(|_| ()).is_err()
  }

  /// The access key pair requests must be signed with.
  #[napi]
  pub fn credentials(&self) -> Result<NativeCredentials> {
    self.read(|emulator| {
      let vended = emulator.credentials();
      let (key, secret) = emulator_server::embedded::signing_key_pair(&vended);
      NativeCredentials {
        access_key_id: key.to_owned(),
        secret_access_key: secret.to_owned(),
      }
    })
  }

  /// PEM of the TLS certificate authority behind any listener the emulator opens (e.g. a
  /// signed URL it hands out).
  #[napi]
  pub fn certificate_authority_pem(&self) -> Result<String> {
    self.read(|emulator| emulator.certificate_authority().pem())
  }

  /// Serve one HTTP request in-process.
  #[napi]
  pub async fn handle(&self, request: NativeRequest) -> Result<NativeResponse> {
    let connector = self.read(AwsEmulatorEmbedded::http_connector)?;
    dispatch(connector, request).await
  }

  /// Drop this emulator and all of its state. Idempotent; requests already in flight
  /// finish, later ones are rejected.
  #[napi]
  pub fn close(&self) {
    let emulator = self
      .inner
      .write()
      .unwrap_or_else(std::sync::PoisonError::into_inner)
      .take();
    drop(emulator);
  }
}

impl NativeEmulator {
  fn read<T>(&self, f: impl FnOnce(&AwsEmulatorEmbedded) -> T) -> Result<T> {
    let guard = self
      .inner
      .read()
      .unwrap_or_else(std::sync::PoisonError::into_inner);
    match guard.as_ref() {
      Some(emulator) => Ok(f(emulator)),
      None => Err(Error::new(Status::GenericFailure, "AwsEmulator is closed")),
    }
  }
}

async fn dispatch(connector: SharedHttpConnector, request: NativeRequest) -> Result<NativeResponse> {
  let mut builder = http::Request::builder()
    .method(request.method.as_str())
    .uri(request.url.as_str());
  for header in &request.headers {
    builder = builder.header(header.name.as_str(), header.value.as_str());
  }
  let body = match request.body {
    Some(body) if !body.is_empty() => SdkBody::from(body.to_vec()),
    _ => SdkBody::empty(),
  };
  let request = builder
    .body(body)
    .map_err(|e| Error::new(Status::InvalidArg, format!("invalid request: {e}")))?;
  let request = HttpRequest::try_from(request)
    .map_err(|e| Error::new(Status::InvalidArg, format!("invalid request: {e}")))?;

  let response = connector
    .call(request)
    .await
    .map_err(|e| Error::from_reason(format!("emulator connector error: {e}")))?;

  let status = response.status().as_u16();
  let headers = response
    .headers()
    .iter()
    .map(|(name, value)| NativeHeader {
      name: name.to_owned(),
      value: value.to_owned(),
    })
    .collect();
  let body = ByteStream::new(response.into_body())
    .collect()
    .await
    .map_err(|e| Error::from_reason(format!("failed to read the emulator response body: {e}")))?
    .into_bytes();

  Ok(NativeResponse {
    status,
    headers,
    body: body.to_vec().into(),
  })
}
