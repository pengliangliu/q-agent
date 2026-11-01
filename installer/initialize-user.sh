#!/usr/bin/env bash
# Launched visibly by the Windows wizard; passwords stay in adduser's terminal.
set -euo pipefail

finish() {
    printf '\n按 Enter 关闭此窗口。\n'
    IFS= read -r _ || true
}
fail() {
    printf '\n%s\n' "$1" >&2
    finish
    exit 1
}

[[ $EUID == 0 ]] || fail '请通过 Q-agent 向导的“创建 Linux 用户”按钮以 root 启动。'
[[ -n "${WSL_DISTRO_NAME:-}" ]] || fail '此功能仅支持 WSL 中的 Ubuntu 或 Debian。'
[[ -r /etc/os-release ]] || fail '无法识别 Linux 发行版。'
. /etc/os-release
[[ "${ID:-}" == ubuntu || "${ID:-}" == debian ]] || fail '此功能仅支持 Ubuntu 或 Debian。'
for command in apt-get adduser getent usermod; do
    command -v "$command" >/dev/null || fail "缺少系统工具 $command，请先完成发行版初始化。"
done
getent group sudo >/dev/null || fail '未找到 sudo 用户组。请先安装发行版的 sudo 软件包，然后重试。'

printf '%s\n' '为当前 WSL 环境创建普通 Linux 用户。密码由 Linux 直接询问，输入时不显示字符。'
printf '%s\n' '也可以复用已有普通用户；复用不会更改密码。'
printf '\n用户名（小写字母开头，可含数字、下划线、连字符；留空取消）：'
IFS= read -r account || account=''
if [[ -z "$account" ]]; then
    printf '\n已取消，未修改用户。\n'
    finish
    exit 0
fi
[[ "$account" =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || fail '用户名格式无效，请重新打开此窗口后输入。'

if entry="$(getent passwd "$account")"; then
    IFS=: read -r existing_name _ uid _ _ existing_home existing_shell <<< "$entry"
    [[ "$existing_name" == "$account" && "$uid" =~ ^[0-9]+$ ]] || fail '无法验证已有用户。'
    [[ "$uid" -ge 1000 && "$uid" -ne 65534 && "$account" != nobody ]] || fail '不能复用 root、系统用户或 nobody 用户，请选择普通用户。'
    [[ "$existing_shell" != */nologin && "$existing_shell" != */false ]] || fail '该用户无法交互登录，请选择正常的 Linux 用户。'
    printf '\n用户 %s 已存在。复用此用户？输入 y 确认，其他输入取消：' "$account"
    IFS= read -r answer || answer=''
    if [[ "$answer" != y && "$answer" != Y ]]; then
        printf '\n已取消，未修改已有用户。\n'
        finish
        exit 0
    fi
    printf '\n已选择已有用户，密码与用户组保持原样。\n'
else
    printf '\n开始创建用户 %s，请直接按 Linux 提示设置密码。\n' "$account"
    if ! adduser -- "$account"; then
        fail '用户创建未完成。请检查上方 Linux 提示；已有用户和密码不会被重置。'
    fi
    if ! usermod -aG sudo -- "$account"; then
        fail '用户已创建，但加入 sudo 组失败。请在 Linux 中完成用户组设置后继续。'
    fi
    printf '\n用户已创建，并加入 sudo 组。\n'
fi
printf '\n请在 Q-agent 向导的“Linux 用户名”栏填写：%s\n' "$account"
printf '%s\n' '然后点击“检测环境”继续。'
finish
