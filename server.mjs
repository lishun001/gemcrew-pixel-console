import { createServer } from 'node:http';
import { isIPv4 } from 'node:net';
import { constants } from 'node:fs';
import { open, opendir, readdir, realpath, readFile, stat, mkdtemp, rm, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';

const port = Number(process.env.PORT ?? 4173);
const listenHost = process.env.LAN_HOST ?? '127.0.0.1';
const lanEnabled = listenHost !== '127.0.0.1';
if (!isIPv4(listenHost) || listenHost === '0.0.0.0') {
  throw new Error('LAN_HOST 必须是服务器网卡的具体 IPv4 地址。');
}
const isMac = process.platform === 'darwin';
const configuredMount = process.platform === 'linux' ? process.env.NAS_MOUNT_POINT?.trim() : '';
if (configuredMount && (!path.isAbsolute(configuredMount) || path.resolve(configuredMount) === '/')) {
  throw new Error('NAS_MOUNT_POINT 必须是 Linux SMB 的绝对挂载路径。');
}
const linuxNasMountPoint = configuredMount ? path.resolve(configuredMount) : '';
const suggestedFolder = process.env.NAS_IMAGE_ROOT ?? (linuxNasMountPoint || '/Volumes/ArtPuzzle/GemCrew/pixel');
const lanRoot = lanEnabled ? path.resolve(suggestedFolder) : '';
if (lanEnabled && (!linuxNasMountPoint || !path.isAbsolute(suggestedFolder) ||
    !isWithin(linuxNasMountPoint, lanRoot))) {
  throw new Error('内网模式需要将 NAS_IMAGE_ROOT 配置为 Linux SMB 挂载点内的素材目录。');
}
const canConnectNas = isMac || Boolean(linuxNasMountPoint);
const volumesFolder = lanRoot || (linuxNasMountPoint ? path.dirname(linuxNasMountPoint) :
  isMac ? '/Volumes' : path.parse(homedir()).root);
const publicFolder = fileURLToPath(new URL('./public/', import.meta.url));
const usageFile = fileURLToPath(new URL('./used-assets.json', import.meta.url));
const feedbackFile = fileURLToPath(new URL('./asset-feedback.json', import.meta.url));
const feedbackLimits = new Map([['unusable', 30], ['revision', 50]]);
const collator = new Intl.Collator('zh-CN', { numeric: true });
const runCommand = promisify(execFile);
const scans = new Map();
let usageWrites = Promise.resolve();
let feedbackWrites = Promise.resolve();
let linuxNasConnection;

const imageTypes = new Map(Object.entries({
  '.png': 'image/png', '.apng': 'image/apng', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.jfif': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
}));
const macImageTypes = new Set([
  '.tif', '.tiff', '.psd', '.heic', '.heif', '.tga', '.icns', '.jxl',
  '.jp2', '.dds', '.exr', '.dng',
]);
const publicFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

function isWithin(root, item) {
  const relative = path.relative(root, item);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function checkLanScope(item) {
  if (lanRoot && !isWithin(lanRoot, item)) {
    throw Object.assign(new Error('内网访问仅限配置的 NAS 素材目录。'), { status: 403 });
  }
}

function parseSmbAddress(value) {
  try {
    const input = value.trim();
    if (!input || /[\u0000-\u001f\u007f\\]/.test(input)) throw new Error();
    const url = new URL(input.includes('://') ? input : 'smb://' + input);
    const share = decodeURIComponent(url.pathname.slice(1).replace(/\/$/, ''));
    if (url.protocol !== 'smb:' || !/^(?:[a-z0-9_.-]+|\[[a-z0-9:.]+\])$/i.test(url.hostname) ||
        url.username || url.password || url.search || url.hash ||
        !share || share === '.' || share === '..' || /[/\\\u0000-\u001f\u007f]/.test(share)) {
      throw new Error();
    }
    if (url.port === '445') url.port = '';
    url.pathname = '/' + encodeURIComponent(share);
    const key = url.host.toLowerCase() + '/' + share.normalize('NFC').toLowerCase();
    return { address: url.href, key };
  } catch {
    throw Object.assign(new Error('请输入 SMB 共享地址，例如 smb://nas.local/素材。账号和密码请在 Finder 中输入。'), { status: 400 });
  }
}

async function readSmbMounts() {
  let stdout;
  try {
    ({ stdout } = await runCommand('/sbin/mount', ['-t', 'smbfs'], { timeout: 5000 }));
  } catch {
    throw Object.assign(new Error('无法读取 macOS 的 SMB 挂载列表。'), { status: 500 });
  }

  const mounts = [];
  for (const line of stdout.split('\n')) {
    const match = /^\/\/(.+?) on (\/.+) \(smbfs(?:,|\))/.exec(line);
    if (!match) continue;
    try {
      const url = new URL('smb://' + match[1]);
      url.username = '';
      url.password = '';
      mounts.push({ ...parseSmbAddress(url.href), folder: match[2] });
    } catch {
      // 挂载列表中无法解析的条目仍可通过「挂载卷」浏览。
    }
  }
  return mounts;
}

async function linuxMountTypes() {
  let mountInfo;
  try {
    mountInfo = await readFile('/proc/self/mountinfo', 'utf8');
  } catch {
    throw Object.assign(new Error('无法读取 Linux 挂载状态。'), { status: 500 });
  }

  const types = new Set();
  for (const line of mountInfo.split('\n')) {
    const [mount, filesystem] = line.split(' - ');
    if (!filesystem) continue;
    const mountPoint = mount.split(' ')[4].replace(/\\([0-7]{3})/g, (_, value) =>
      String.fromCharCode(Number.parseInt(value, 8)));
    if (mountPoint === linuxNasMountPoint) types.add(filesystem.split(' ')[0]);
  }
  return types;
}

function hasSmbMount(types) {
  return types.has('cifs') || types.has('smb3');
}

async function openLinuxNas() {
  const types = await linuxMountTypes();
  if (!hasSmbMount(types) && !types.has('autofs')) {
    throw Object.assign(new Error('未找到 SMB 挂载。请在 Linux 主机上启动对应的自动挂载单元。'), { status: 503 });
  }

  try {
    // 打开目录会触发 Linux 自动挂载，并检查当前用户能否读取该目录。
    const directory = await opendir(linuxNasMountPoint);
    await directory.close();
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      throw Object.assign(new Error('没有权限读取 NAS，请检查共享账号和 Linux 挂载权限。'), { status: 403 });
    }
    throw Object.assign(new Error('NAS 连接失败，请检查网络和 Linux 挂载单元状态。'), { status: 503 });
  }
  if (!hasSmbMount(await linuxMountTypes())) {
    throw Object.assign(new Error('自动挂载未建立 SMB 连接，请检查 Linux 挂载单元状态。'), { status: 503 });
  }
  return linuxNasMountPoint;
}

function connectLinuxNas() {
  linuxNasConnection ??= openLinuxNas().finally(() => {
    linuxNasConnection = undefined;
  });
  return linuxNasConnection;
}

async function handleNas(request, response, url) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return sendJson(response, 405, { error: '请求方式无效。' });
  }
  if (!canConnectNas) {
    return sendJson(response, 501, { error: '请使用系统连接 NAS 后，在素材库中选择挂载目录。' });
  }
  if (linuxNasMountPoint) {
    if (request.method === 'POST') {
      const folder = lanRoot ? await absoluteFolder(lanRoot) : await connectLinuxNas();
      return sendJson(response, 200, { folder });
    }
    const mounted = hasSmbMount(await linuxMountTypes());
    return sendJson(response, 200, { folder: mounted ? lanRoot || linuxNasMountPoint : null });
  }

  const target = parseSmbAddress(url.searchParams.get('address') ?? '');
  const mount = (await readSmbMounts()).find(entry => entry.key === target.key);
  if (mount) return sendJson(response, 200, { address: target.address, folder: mount.folder });
  if (request.method === 'GET') return sendJson(response, 200, { address: target.address, folder: null });

  try {
    await runCommand('/usr/bin/open', [target.address], { timeout: 10000 });
  } catch {
    return sendJson(response, 500, { error: '无法打开 Finder，请在 Finder 中选择「前往 → 连接服务器」。' });
  }
  return sendJson(response, 202, { address: target.address, folder: null });
}

async function readUsage() {
  try {
    const paths = JSON.parse(await readFile(usageFile, 'utf8'));
    if (Array.isArray(paths) && paths.every(value => typeof value === 'string' && path.isAbsolute(value))) {
      return new Set(paths);
    }
  } catch (error) {
    if (error.code === 'ENOENT') return new Set();
  }
  throw Object.assign(new Error('无法读取已使用记录，请检查项目中的 used-assets.json。'), { status: 500 });
}

async function writeRecords(file, data, errorMessage) {
  const temporaryFile = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporaryFile, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporaryFile, file);
  } catch {
    throw Object.assign(new Error(errorMessage), { status: 500 });
  } finally {
    await rm(temporaryFile, { force: true }).catch(() => {});
  }
}

function saveUsage(absolutePath, used) {
  const write = usageWrites.then(async () => {
    const paths = await readUsage();
    if (paths.has(absolutePath) === used) return;
    if (used) paths.add(absolutePath);
    else paths.delete(absolutePath);

    await writeRecords(usageFile, [...paths].sort(), '无法保存已使用记录，请检查项目目录的写入权限。');
  });
  // 保存失败时，后续请求仍可继续尝试。
  usageWrites = write.catch(() => {});
  return write;
}

function validComment(type, comment) {
  return feedbackLimits.has(type) && typeof comment === 'string' &&
    Array.from(comment).length <= feedbackLimits.get(type);
}

async function readFeedback() {
  try {
    const data = JSON.parse(await readFile(feedbackFile, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const entries = Object.entries(data);
      if (entries.every(([asset, record]) => path.isAbsolute(asset) &&
          record && typeof record === 'object' && !Array.isArray(record) &&
          Object.entries(record).every(([type, comment]) => validComment(type, comment)))) {
        return new Map(entries);
      }
    }
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
  }
  throw Object.assign(new Error('无法读取图片反馈，请检查项目中的 asset-feedback.json。'), { status: 500 });
}

function saveFeedback(absolutePath, type, comment) {
  const write = feedbackWrites.then(async () => {
    const records = await readFeedback();
    const feedback = records.get(absolutePath) ?? {};
    if ((feedback[type] ?? null) === comment) return feedback;
    if (comment === null) delete feedback[type];
    else feedback[type] = comment;
    if (Object.keys(feedback).length) records.set(absolutePath, feedback);
    else records.delete(absolutePath);
    await writeRecords(feedbackFile, Object.fromEntries(records), '无法保存图片反馈，请检查项目目录的写入权限。');
    return feedback;
  });
  feedbackWrites = write.catch(() => {});
  return write;
}

async function handleFeedback(request, response, asset) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    return sendJson(response, 415, { error: '反馈请求需要使用 JSON。' });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 4096) {
      response.setHeader('Connection', 'close');
      return sendJson(response, 413, { error: '反馈内容过长。' });
    }
    chunks.push(chunk);
  }
  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return sendJson(response, 400, { error: '反馈内容格式无效。' });
  }
  const { type, comment } = data ?? {};
  if (!feedbackLimits.has(type) || (comment !== null && typeof comment !== 'string')) {
    return sendJson(response, 400, { error: '反馈类型或评论内容无效。' });
  }
  if (comment !== null && !validComment(type, comment)) {
    return sendJson(response, 400, { error: '评论最多 ' + feedbackLimits.get(type) + ' 字。' });
  }
  return sendJson(response, 200, { feedback: await saveFeedback(asset.absolute, type, comment) });
}

async function absoluteFolder(value) {
  const folder = value?.trim();
  if (!folder || !path.isAbsolute(folder)) {
    throw Object.assign(new Error('请输入已挂载目录的绝对路径。'), { status: 400 });
  }
  const absolute = lanRoot ? path.resolve(folder) : path.normalize(folder);
  checkLanScope(absolute);
  if (linuxNasMountPoint && isWithin(linuxNasMountPoint, absolute)) {
    await connectLinuxNas();
  }
  const source = lanRoot ? await realpath(absolute) : absolute;
  checkLanScope(source);
  if (!(await stat(source)).isDirectory()) {
    throw Object.assign(new Error('请选择一个文件夹。'), { status: 400 });
  }
  return absolute;
}

async function scanFolder(folder, recursive, response) {
  const directories = [folder];
  const images = [];
  const root = await realpath(folder);
  checkLanScope(root);
  let skipped = 0;

  while (directories.length && !response.destroyed) {
    const directory = directories.pop();
    let entries;
    try {
      const source = lanRoot ? await realpath(directory) : directory;
      checkLanScope(source);
      entries = await readdir(source, { withFileTypes: true });
    } catch (error) {
      if (directory === folder) throw error;
      skipped++;
      continue;
    }

    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (recursive && entry.isDirectory()) {
        directories.push(absolute);
      } else if (entry.isFile() && !entry.name.startsWith('._')) {
        const extension = path.extname(entry.name).toLowerCase();
        if (imageTypes.has(extension) || macImageTypes.has(extension)) {
          images.push({
            name: entry.name,
            absolute,
            relative: path.relative(folder, absolute),
            extension,
            converted: !imageTypes.has(extension),
            fields: entry.name.slice(0, -extension.length).split('_'),
          });
        }
      }
    }
  }

  let usedPaths = new Set();
  let usageProblem = '';
  try {
    await usageWrites;
    usedPaths = await readUsage();
  } catch (error) {
    usageProblem = error.message;
  }
  let feedbackRecords = new Map();
  let feedbackProblem = '';
  try {
    await feedbackWrites;
    feedbackRecords = await readFeedback();
  } catch (error) {
    feedbackProblem = error.message;
  }
  if (response.destroyed) return;
  images.sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.relative, b.relative));
  const scanId = randomUUID();
  scans.set(scanId, { root, images });
  if (scans.size > 8) scans.delete(scans.keys().next().value);

  sendJson(response, 200, {
    folder,
    skipped,
    usageProblem,
    feedbackProblem,
    images: images.map((asset, index) => ({
      ...asset,
      used: usedPaths.has(asset.absolute),
      feedback: feedbackRecords.get(asset.absolute) ?? {},
      url: '/image/' + scanId + '/' + index,
    })),
  });
}

async function serveImage(response, scanId, index) {
  const scan = scans.get(scanId);
  const asset = scan?.images[index];
  if (!asset) return sendJson(response, 404, { error: '图片已失效，请刷新目录。' });
  const source = await realpath(asset.absolute);
  checkLanScope(source);
  if (!isWithin(scan.root, source)) {
    return sendJson(response, 404, { error: '图片已移出所选目录。' });
  }

  const type = imageTypes.get(asset.extension);
  if (!type) {
    if (process.platform !== 'darwin') {
      return sendJson(response, 415, { error: '当前系统缺少该格式的预览支持。' });
    }
    const directory = await mkdtemp(path.join(tmpdir(), 'gemcrew-preview-'));
    try {
      const preview = path.join(directory, 'preview.png');
      await runCommand('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '1600', source, '--out', preview], {
        timeout: 20000,
      });
      const content = await readFile(preview);
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': content.length,
        'Cache-Control': 'private, max-age=300',
      });
      response.end(content);
    } catch {
      if (!response.destroyed) sendJson(response, 415, { error: '无法生成此图片的预览。' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    return;
  }

  const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) return sendJson(response, 404, { error: '图片已移除。' });
    response.writeHead(200, {
      'Content-Type': type,
      'Content-Length': info.size,
      'Cache-Control': 'private, max-age=300',
    });
    await pipeline(file.createReadStream({ autoClose: false }), response);
  } finally {
    await file.close();
  }
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Referrer-Policy', 'no-referrer');

  try {
    const allowedHosts = lanEnabled ? [listenHost] : ['127.0.0.1', 'localhost'];
    const suffix = server.address().port === 80 ? '' : ':' + server.address().port;
    const hosts = allowedHosts.map(host => host + suffix);
    if (!hosts.includes(request.headers.host) ||
        request.headers['sec-fetch-site'] === 'cross-site' ||
        (request.headers.origin && request.headers.origin !== 'http://' + request.headers.host)) {
      return sendJson(response, 403, { error: '请通过服务配置的地址访问。' });
    }
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/') && request.headers['x-gemcrew-console'] !== '1') {
      return sendJson(response, 403, { error: '请通过素材库页面访问。' });
    }
    if (url.pathname === '/api/nas') return await handleNas(request, response, url);

    const update = /^\/api\/(usage|feedback)\/([a-f0-9-]+)\/(\d+)$/.exec(url.pathname);
    if (update) {
      if (request.method !== 'PUT') return sendJson(response, 405, { error: '请求方式无效。' });
      const [, action, scanId, index] = update;
      const asset = scans.get(scanId)?.images[Number(index)];
      if (!asset) return sendJson(response, 404, { error: '图片已失效，请刷新目录。' });
      if (action === 'feedback') return await handleFeedback(request, response, asset);
      const value = url.searchParams.get('used');
      if (value !== '1' && value !== '0') return sendJson(response, 400, { error: '使用状态无效。' });
      const used = value === '1';
      await saveUsage(asset.absolute, used);
      return sendJson(response, 200, { used });
    }
    if (request.method !== 'GET') return sendJson(response, 405, { error: '请求方式无效。' });

    if (url.pathname === '/api/config') {
      return sendJson(response, 200, {
        suggestedFolder, volumesFolder, canConnectNas, linuxNasMountPoint,
        feedbackLimits: Object.fromEntries(feedbackLimits),
      });
    }
    if (url.pathname === '/api/folders') {
      const folder = await absoluteFolder(url.searchParams.get('path') ?? volumesFolder);
      const source = lanRoot ? await realpath(folder) : folder;
      checkLanScope(source);
      const entries = await readdir(source, { withFileTypes: true });
      const folders = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .sort((a, b) => collator.compare(a.name, b.name))
        .map(entry => ({ name: entry.name, path: path.join(folder, entry.name) }));
      return sendJson(response, 200, { folder, parent: folder === lanRoot ? folder : path.dirname(folder), folders });
    }
    if (url.pathname === '/api/assets') {
      const folder = await absoluteFolder(url.searchParams.get('path'));
      return await scanFolder(folder, url.searchParams.get('recursive') === '1', response);
    }
    const image = /^\/image\/([a-f0-9-]+)\/(\d+)$/.exec(url.pathname);
    if (image) {
      response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      return await serveImage(response, image[1], Number(image[2]));
    }
    const staticFile = publicFiles.get(url.pathname);
    if (staticFile) {
      const [file, type] = staticFile;
      const content = await readFile(path.join(publicFolder, file));
      response.setHeader('Content-Security-Policy',
        "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      response.writeHead(200, { 'Content-Type': type });
      return response.end(content);
    }
    if (url.pathname === '/favicon.ico') {
      response.writeHead(204);
      return response.end();
    }
    return sendJson(response, 404, { error: '找不到页面。' });
  } catch (error) {
    if (response.destroyed) return;
    if (response.headersSent) return response.destroy();
    if (error.status) return sendJson(response, error.status, { error: error.message });
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return sendJson(response, 404, { error: '找不到该路径，请检查 NAS 是否已挂载。' });
    }
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return sendJson(response, 403, { error: '没有读取该路径的权限。' });
    }
    return sendJson(response, 500, { error: '读取失败，请检查 NAS 连接后重试。' });
  }
});

server.on('error', error => {
  console.error('素材库启动失败：' + error.message);
  process.exitCode = 1;
});
server.listen(port, listenHost, () => {
  console.log('GemCrew 像素素材库：http://' + listenHost + ':' + server.address().port);
});
