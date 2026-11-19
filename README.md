# conv-quote

A Claude Code mod for quoting earlier parts of the conversation instead of copying and pasting them.

- **Quote a selection**: select transcript text with the mouse (fullscreen mode), then press **Quote selection** above the prompt (inserts `[Q1] ` at the cursor so you can comment right after it) or run `/quote [comment]`. Add as many quotes as you like; each is listed above the prompt with a ✕ to remove it.
- **Precise location for the agent**: on submit, the quotes are attached to your prompt with the source message id, role, sequence number, time, the span (`chars=start-end`) inside the message and a little surrounding text. The agent can call `mcp__conv-quote__locate` for slightly more text around a quote. It is deliberately local: at most 500 characters per call.
- **Message header**: every message shows its time, short id and sequence number below it.
- **Timeline** (hidden by default): `/timeline` or the **Timeline** button opens a pane with one row per message; click a row to jump to it, or **Q** to quote the whole message. Esc closes it.
- **Language**: Chinese when Claude Code's `language` setting names Chinese (e.g. `"language": "chinese"`), English otherwise.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install conv-quote --marketplace okayzk/conv-quote
```

Answer `y` to add the marketplace, then pick a scope (user scope first, Enter to choose).

From a shell:

```
claude plugin install conv-quote --marketplace okayzk/conv-quote
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `okayzk/conv-quote`, then Add plugin.

Selecting text requires Claude Code's fullscreen mode.

## 中文说明

在 TUI 里用鼠标选中对话内容（需要全屏模式），点输入框上方的「引用选区」或输入 `/quote [评论]` 即可引用，可以引用多条并分别写评论。发送时引用会带上原消息的 ID、序号、时间和在消息中的位置，agent 能据此精确定位。`/timeline` 打开对话时间线，可以跳转或整条引用。Claude Code 的 `language` 设置为中文时界面显示中文，其他情况显示英文。安装命令见上方 Install。
