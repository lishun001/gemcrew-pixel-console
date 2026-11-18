# 在 Linux 上自动连接 NAS

以下步骤适用于使用 systemd 的 Linux 主机。示例把 ArtPuzzle 共享只读挂载到 `/Volumes/ArtPuzzle`。

## 用脚本部署

在已安装 Node.js 的 Linux 服务器上进入项目目录，运行以下命令。

```bash
sudo bash deploy-linux.sh
```

网站默认以 `root` 运行，端口为 `14173`。在 `root` 终端可直接运行 `bash deploy-linux.sh`。首次运行时按提示填写 NAS 账号和密码。已有匹配的 `/etc/fstab` 自动挂载配置可以继续使用。用 `bash deploy-linux.sh --help` 查看指定运行用户、Node.js 路径、端口或共享地址的方法。

部署完成后，从客户端运行 SSH 转发命令，将 `用户名@Linux服务器` 换成实际登录地址，然后打开 [素材库](http://127.0.0.1:14173/)。

```bash
ssh -N -L 127.0.0.1:14173:127.0.0.1:14173 用户名@Linux服务器
```

## 手动配置系统挂载

1. 安装发行版提供的 `cifs-utils`，然后创建挂载目录和凭据文件。

   ```bash
   sudo mkdir -p /Volumes/ArtPuzzle
   sudo install -d -m 0700 /etc/gemcrew
   sudo touch /etc/gemcrew/artpuzzle.credentials
   sudo chmod 0600 /etc/gemcrew/artpuzzle.credentials
   sudoedit /etc/gemcrew/artpuzzle.credentials
   ```

   ```ini
   username=你的 NAS 账号
   password=你的 NAS 密码
   ```

2. 用 `sudoedit /etc/fstab` 添加以下一行。如果该挂载点已有条目，就更新现有条目。用 `id -u` 和 `id -g` 查看运行素材库的用户和组，把示例中的两个 `1000` 替换成实际值。

   ```fstab
   //192.168.1.5/ArtPuzzle /Volumes/ArtPuzzle cifs ro,credentials=/etc/gemcrew/artpuzzle.credentials,uid=1000,gid=1000,file_mode=0440,dir_mode=0550,_netdev,nofail,x-systemd.automount,x-systemd.mount-timeout=20s 0 0
   ```

3. 重新加载配置并启动自动挂载单元。

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl start "$(systemd-escape --path --suffix=automount /Volumes/ArtPuzzle)"
   ```

## 启动素材库

在项目目录运行以下命令。

```bash
NAS_MOUNT_POINT=/Volumes/ArtPuzzle NAS_IMAGE_ROOT=/Volumes/ArtPuzzle/GemCrew/pixel npm start
```

如果素材库由 systemd 服务运行，把该服务里的 `NAS_MOUNT_POINT` 和 `NAS_IMAGE_ROOT` 更新为上面的路径，再重新加载并重启服务。

打开 [素材库](http://127.0.0.1:4173/) 会尝试读取素材目录并触发挂载。也可以点击右上角的「连接 NAS」，挂载确认后会进入目录选择器。「浏览挂载卷」从 `/Volumes` 打开。

连接失败时，可通过以下命令查看 Linux 挂载单元的错误。

```bash
systemctl status "$(systemd-escape --path --suffix=mount /Volumes/ArtPuzzle)"
```
