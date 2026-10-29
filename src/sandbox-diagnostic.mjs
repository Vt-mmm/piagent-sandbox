// What a failed command tells the agent. Every environment failure names the way on: a tool that asks the member
// (run_with_network, run_with_docker, start_docker, fetch_origin, run_on_host) or a question to the member, never
// "tell the user and stop". The first matching rule wins; `network`, `isolated`, `docker` and `engine` say how the command ran.
const DENIAL = /\b(?:EPERM|EACCES)\b|operation not permitted|permission denied/i;
const OFFLINE = new RegExp(['ENOTFOUND|EAI_AGAIN|Could not resolve host|getaddrinfo|npm error network|Failed to establish a new connection',
  String.raw`\bcurl: (?:\(\d+\) )?Failed to (?:fetch|connect)|\bwget: (?:unable to resolve|Failed to fetch)`, 'Unknown host|UnknownHostException'].join('|'), 'i');
const DOCKER_DAEMON = /Cannot connect to the Docker daemon|connect to the docker API|docker\.sock|Is the docker daemon running|Could not find a valid Docker environment/i;
const TOOLCHAIN = new RegExp([
  'Unable to locate a Java Runtime|No Java runtime present|JAVA_HOME is not (?:set|defined correctly)',
  String.raw`(?:^|\n)\S*?(?:ba|z)?sh: (?:line \d+: )?[\w.+-]+: command not found|zsh: command not found: [\w.+-]+`,
  'xcrun: error: (?:unable to find utility|invalid active developer path)', String.raw`env: '?[\w.+-]+'?: No such file or directory`,
  String.raw`Unsupported class file major version|invalid target release: \d+|release version \d+ not supported|requires? (?:at least )?Java \d+`,
  'The engine "node" is incompatible|Unsupported engine'].join('|'), 'i');
const SIMULATOR = new RegExp(['CoreSimulator|simctl|Unable to boot device|Unable to lookup in current state|Failed to start launchd_sim',
  'adb: (?:cannot connect|failed to check server version|no devices|device offline)|cannot connect to daemon',
  String.raw`\bemulator: (?:ERROR|PANIC)|Unable to find a destination`].join('|'), 'i');
const SIGN_IN = new RegExp(['could not read (?:Username|Password) for', 'terminal prompts disabled', 'Authentication failed for', String.raw`Permission denied \(publickey`,
  'Host key verification failed', 'not logged into any GitHub hosts', String.raw`please run:\s+gh auth login`, 'Could not open a connection to your authentication agent',
  String.raw`\bENEEDAUTH\b|\bE401\b|\b401 Unauthorized|requires authentication`, 'denied: requested access to the resource is denied|pull access denied'].join('|'), 'i');
const PROXY_REFUSED = /CONNECT tunnel failed|tunneling socket|statusCode=403|response 403/i;

export function sandboxDiagnostic(message, { network = false, isolated = false, docker = false, engine = false } = {}) {
  const text = String(message);
  const say = (code, advice) => `${code}: ${advice}\n${text}`;
  if (!network && SIMULATOR.test(text)) {
    return say('managed-simulator-unreachable', 'Lệnh bash trong sandbox không tới được iOS Simulator hay Android emulator. '
      + 'Chạy lệnh simulator (xcrun simctl, xcodebuild cho simulator, adb, emulator, ./gradlew installDebug, flutter, npx expo) bằng run_on_simulator.');
  }
  if (docker && DOCKER_DAEMON.test(text)) {
    return say('managed-docker-unreachable', 'Lệnh chạy với Docker nhưng Docker engine không trả lời. '
      + 'Gọi start_docker để xin member duyệt mở Docker, rồi chạy lại đúng lệnh này bằng run_with_docker.');
  }
  if (!docker && DOCKER_DAEMON.test(text)) {
    return engine
      ? say('managed-docker-blocked', 'Lệnh bash thường không dùng được Docker trong chế độ công ty. Lệnh docker, docker compose, hoặc test cần Docker (Testcontainers) chạy qua run_with_docker.')
      : say('managed-docker-unavailable', 'Docker engine trên máy chưa chạy. Gọi start_docker để xin member duyệt mở Docker, rồi chạy lệnh bằng run_with_docker.');
  }
  if (TOOLCHAIN.test(text)) {
    return say('managed-toolchain-missing', 'Máy thiếu runtime/công cụ mà lệnh cần, hoặc sai version project yêu cầu. Đừng dừng ở đây: xem project cần gì '
      + '(pom.xml, build.gradle, .nvmrc, .tool-versions, package.json engines…) rồi dùng run_on_host để xin member duyệt cài trên máy '
      + '(ví dụ brew install openjdk@21, brew install node@22), sau đó chạy lại lệnh. Trình cài cần mật khẩu (sudo, file .pkg) thì hỏi member.');
  }
  if (SIGN_IN.test(text)) {
    return say('managed-credentials-unavailable', 'Lệnh cần tài khoản đăng nhập của member (git qua HTTPS/SSH, registry riêng, image riêng), sandbox không có. '
      + 'git fetch dùng fetch_origin; git pull, git push, cài từ registry riêng hoặc pull image riêng thì dùng run_on_host để member duyệt chạy đúng lệnh đó.');
  }
  if (isolated && !PROXY_REFUSED.test(text) && /ECONNREFUSED|EPERM|connect|Connection refused|could not connect|fetch failed/i.test(text)) {
    return say('managed-loopback-blocked', 'Máy đang chạy một proxy cục bộ, nên lệnh không có mạng cũng không được kết nối tới server trên localhost '
      + '(proxy có thể đưa lệnh ra internet). Test cần server hoặc database trên localhost: dùng run_with_network để người dùng duyệt đúng lệnh đó.');
  }
  if (network && !DENIAL.test(text) && OFFLINE.test(text)) {
    return say('managed-network-unreachable', 'Lệnh đã được duyệt và chạy có mạng nhưng không tới được host (máy offline, cần VPN/proxy công ty, hoặc sai tên host). '
      + 'Hỏi member, kèm lựa chọn "Đã kết nối mạng/VPN, chạy lại" và "Bỏ qua bước này".');
  }
  if (!DENIAL.test(text)) {
    return OFFLINE.test(text)
      ? say('managed-network-blocked', 'Lệnh bash thường không có mạng trong chế độ công ty. Nếu lệnh thật sự cần mạng (cài package, tải dữ liệu), '
        + 'dùng run_with_network để người dùng duyệt đúng lệnh đó.')
      : text;
  }
  // /tmp is shared by every process on the Mac, so it stays read-only; each command has its own $TMPDIR.
  if (/(?:^|[\s'"=:(])\/(?:private\/)?tmp\//.test(text)) {
    return say('managed-sandbox-denied', '/tmp chỉ được đọc trong chế độ công ty. Ghi file tạm (log, kết quả test) vào "$TMPDIR" hoặc trong project.');
  }
  return say('managed-sandbox-denied', 'Sandbox chặn thao tác này (ghi ngoài project, Keychain, file credential như .env/.npmrc, thư mục hệ thống). '
    + 'Nếu task thật sự cần nó, dùng run_on_host để member duyệt chạy đúng lệnh đó trên máy, ngoài sandbox. Lệnh chỉ cần mạng thì dùng run_with_network; git fetch dùng fetch_origin.');
}
