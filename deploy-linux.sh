#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

if [[ ${1:-} == --help ]]; then
  printf '%s\n' '在装有 Node.js 20+ 的 systemd Linux 上，从项目目录运行 sudo bash deploy-linux.sh。' \
    '网站服务默认使用 root 运行，可通过 APP_USER 指定其他账号。' \
    '可用 sudo env APP_USER=用户名 NODE_BIN=/usr/bin/node PORT=14173 NAS_SHARE=//服务器/共享名 bash deploy-linux.sh 指定配置。'
  exit 0
fi
[[ $# == 0 ]] || fail '请通过环境变量指定部署配置，或运行 bash deploy-linux.sh --help。'
[[ $(uname -s) == Linux && -d /run/systemd/system ]] || fail '此脚本需要运行 systemd 的 Linux 主机。'
(( EUID == 0 )) || fail '请运行 sudo bash deploy-linux.sh。'

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
app_user=${APP_USER:-root}
port=${PORT:-14173}
nas_share=${NAS_SHARE:-//192.168.1.5/ArtPuzzle}
node_bin=${NODE_BIN:-$(command -v node || true)}
mount_point=/Volumes/ArtPuzzle
image_root=$mount_point/GemCrew/pixel
credentials_dir=/etc/gemcrew
credentials_file=$credentials_dir/artpuzzle.credentials
unit_dir=/etc/systemd/system
app_unit=gemcrew-pixel-console.service
managed_marker='# Managed by GemCrew deploy-linux.sh'

app_uid=$(id -u -- "$app_user") || fail '找不到应用用户。'
app_gid=$(id -g -- "$app_user")
[[ "$port" =~ ^[1-9][0-9]{0,4}$ ]] && (( port <= 65535 )) || fail 'PORT 必须在 1 到 65535 之间。'
[[ "$nas_share" =~ ^//(\[[[:xdigit:]:]+\]|[A-Za-z0-9._-]+)/[^/[:space:][:cntrl:]\\]+$ ]] ||
  fail 'NAS_SHARE 请使用 //服务器/共享名 的格式。'
[[ "$project_dir" != *[[:cntrl:]]* && "$node_bin" == /* && "$node_bin" != *[[:cntrl:]]* ]] ||
  fail '请先安装 Node.js 24 LTS，或用 NODE_BIN 指定 Node.js 的绝对路径。'
version=$(runuser -u "$app_user" -- "$node_bin" --version) || fail '应用用户无法运行 Node.js。'
[[ "$version" =~ ^v([0-9]+)\. ]] && (( BASH_REMATCH[1] >= 20 )) || fail '项目需要 Node.js 20 或以上版本。'
runuser -u "$app_user" -- test -w "$project_dir" || fail '应用用户需要写入项目目录，以保存 used-assets.json。'
for file in server.mjs public/index.html public/app.js public/styles.css; do
  runuser -u "$app_user" -- test -r "$project_dir/$file" || fail "应用用户无法读取 ${file}。"
done
if [[ -e "$project_dir/used-assets.json" ]]; then
  runuser -u "$app_user" -- test -r "$project_dir/used-assets.json" || fail '应用用户无法读取现有的 used-assets.json。'
fi
runuser -u "$app_user" -- "$node_bin" --check "$project_dir/server.mjs"

exec 9>/run/gemcrew-pixel-console-deploy.lock
flock -n 9 || fail '已有部署在运行。'
systemctl show --property=Version --value >/dev/null || fail '无法连接系统的 systemd 管理器。'

mount_unit=$(systemd-escape --path --suffix=mount "$mount_point")
automount_unit=$(systemd-escape --path --suffix=automount "$mount_point")
fstab=$(findmnt --fstab --mountpoint "$mount_point" --noheadings --raw --output SOURCE,FSTYPE,OPTIONS || true)
units=("$app_unit")
if [[ -n "$fstab" ]]; then
  read -r source type options <<< "$fstab"
  [[ "$fstab" != *$'\n'* && "$source" == "$nas_share" && ( "$type" == cifs || "$type" == smb3 ) &&
     ",$options," == *,x-systemd.automount,* && ",$options," == *,ro,* ]] ||
    fail "$mount_point 已有不同的 fstab 配置，请核对共享地址与只读自动挂载选项。"
  for unit in "$mount_unit" "$automount_unit"; do
    [[ ! -e "$unit_dir/$unit" && ! -L "$unit_dir/$unit" ]] ||
      fail "$mount_point 同时配置了 fstab 和 systemd 单元，请保留一套配置。"
  done
else
  units+=("$mount_unit" "$automount_unit")
fi
for unit in "${units[@]}"; do
  fragment=$(systemctl show --property=FragmentPath --value "$unit" 2>/dev/null || true)
  [[ -z "$fragment" || "$fragment" == "$unit_dir/$unit" ]] || fail "已有独立配置 ${fragment}，请先核对。"
  destination=$unit_dir/$unit
  if [[ -e "$destination" || -L "$destination" ]]; then
    [[ ! -L "$destination" && -f "$destination" && $(head -n 1 "$destination") == "$managed_marker" ]] ||
      fail "已存在 ${destination}，请备份并移开原有手动配置后重试。"
  fi
done

mounted=false
active_mounts=$(findmnt --kernel --mountpoint "$mount_point" --noheadings --raw --output SOURCE,FSTYPE || true)
while read -r source type; do
  case "$type" in
    ''|autofs) ;;
    cifs|smb3)
      [[ "$source" == "$nas_share" ]] || fail "$mount_point 已挂载其他 NAS 共享。"
      mounted=true ;;
    *) fail "$mount_point 已被其他文件系统占用。" ;;
  esac
done <<< "$active_mounts"

if ! command -v mount.cifs >/dev/null && [[ ! -x /sbin/mount.cifs && ! -x /usr/sbin/mount.cifs ]]; then
  if command -v apt-get >/dev/null; then
    apt-get install -y cifs-utils || { apt-get update && apt-get install -y cifs-utils; }
  elif command -v dnf >/dev/null; then
    dnf install -y cifs-utils
  else
    fail '请先用系统的软件包管理器安装 cifs-utils。'
  fi
fi

if [[ -z "$fstab" ]]; then
  if [[ ! -e "$credentials_file" && ! -L "$credentials_file" ]]; then
    [[ -t 0 ]] || fail "请预先创建 root 专用的 ${credentials_file}，或在交互终端运行脚本。"
    if [[ ! -e "$credentials_dir" && ! -L "$credentials_dir" ]]; then
      install -d -m 0700 "$credentials_dir"
    fi
    [[ -d "$credentials_dir" && ! -L "$credentials_dir" && $(stat -c '%u:%a' -- "$credentials_dir") == 0:700 ]] ||
      fail "$credentials_dir 须为 root 持有的目录，权限设为 0700。"
    set +x
    IFS= read -r -p 'NAS 账号：' nas_user
    IFS= read -r -s -p 'NAS 密码：' nas_password
    printf '\n'
    [[ -n "$nas_user" && -n "$nas_password" ]] || fail '请填写 NAS 账号和密码。'
    staged_credentials=$(mktemp "$credentials_dir/.artpuzzle.XXXXXX")
    if ! printf 'username=%s\npassword=%s\n' "$nas_user" "$nas_password" > "$staged_credentials" ||
       ! mv -T -- "$staged_credentials" "$credentials_file"; then
      rm -f -- "$staged_credentials"
      fail '无法保存 NAS 凭据文件。'
    fi
    unset nas_user nas_password
  fi
  [[ -f "$credentials_file" && ! -L "$credentials_file" ]] || fail "无效的凭据文件 ${credentials_file}。"
  case "$(stat -c '%u:%a' -- "$credentials_file")" in
    0:600|0:400) ;;
    *) fail "$credentials_file 须由 root 持有，权限设为 0600 或 0400。" ;;
  esac
fi

unit_argument() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//%/%%}
  printf '"%s"' "$value"
}

stage=$(mktemp -d "$unit_dir/.gemcrew-deploy.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT
if [[ -z "$fstab" ]]; then
  cat > "$stage/$mount_unit" <<EOF
$managed_marker
[Mount]
What=${nas_share//%/%%}
Where=$mount_point
Type=cifs
Options=ro,credentials=$credentials_file,uid=$app_uid,gid=$app_gid,file_mode=0440,dir_mode=0550,_netdev,nodev,nosuid,noexec
TimeoutSec=20s
EOF
  cat > "$stage/$automount_unit" <<EOF
$managed_marker
[Automount]
Where=$mount_point

[Install]
WantedBy=multi-user.target
EOF
fi
cat > "$stage/$app_unit" <<EOF
$managed_marker
[Unit]
Description=GemCrew Pixel Console
After=$automount_unit

[Service]
User=$app_uid
Group=$app_gid
Environment=PORT=$port
Environment=NAS_MOUNT_POINT=$mount_point
Environment=NAS_IMAGE_ROOT=$image_root
ExecStart=$(unit_argument ":$node_bin") $(unit_argument "$project_dir/server.mjs")
Restart=on-failure
RestartSec=2s

[Install]
WantedBy=multi-user.target
EOF

for unit in "${units[@]}"; do
  if ! cmp -s -- "$stage/$unit" "$unit_dir/$unit"; then
    chmod 0644 "$stage/$unit"
    mv -T -- "$stage/$unit" "$unit_dir/$unit"
  fi
done
systemctl daemon-reload
if [[ -z "$fstab" ]]; then
  systemctl enable "$automount_unit"
fi
if [[ "$mounted" == false ]]; then
  systemctl start "$automount_unit"
fi
systemctl enable "$app_unit"
systemctl restart "$app_unit"

if ! runuser -u "$app_user" -- "$node_bin" --input-type=module - "$port" "$image_root" <<'JS'
const [port, root] = process.argv.slice(2);
const base = 'http://127.0.0.1:' + port;
const headers = { 'X-GemCrew-Console': '1' };
try {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(base + '/api/config', { headers, signal: AbortSignal.timeout(1500) });
      if (!response.ok || (await response.json()).suggestedFolder !== root) {
        throw new Error('服务端口或默认素材目录与部署配置不符。');
      }
      break;
    } catch (error) {
      if (attempt === 14) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  const url = new URL('/api/folders', base);
  url.searchParams.set('path', root);
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
} catch (error) {
  process.stderr.write('部署验证失败：' + error.message + '\n');
  process.exitCode = 1;
}
JS
then
  fail "可用 systemctl status $app_unit $mount_unit 查看状态。修正配置后重新运行本脚本。"
fi

printf '已部署并验证素材目录 %s\n' "$image_root"
printf '服务器本机入口 http://127.0.0.1:%s/\n' "$port"
printf '从客户端访问时可执行 ssh -N -L 127.0.0.1:%s:127.0.0.1:%s 用户名@Linux服务器\n' "$port" "$port"
