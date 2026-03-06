# Autonomous Loop Agent (OpenAI Agent SDK)

Agent nay chay bang **OpenAI Agent SDK** (`@openai/agents`) va vong lap tu dong duoc SDK quan ly san.

Luong xu ly:
1. Nhan muc tieu
2. Goi `run(agent, input)`
3. SDK tu xu ly tool call -> chay tool -> tra ket qua cho model
4. Lap den khi co cau tra loi cuoi cung hoac den `MAX_TURNS`

## 1) Cai dat

```bash
npm install
```

## 2) Cau hinh

Tao file `.env` tu `.env.example`:

```bash
cp .env.example .env
```

Cap nhat:

- `OPENAI_API_KEY`: bat buoc
- `OPENAI_MODEL`: tuy chon (mac dinh `gpt-4.1-mini`)
- `MAX_TURNS`: so vong lap toi da
- `AUTO_CONTINUE_ON_MAX_TURNS`: `true/false`, tu dong chay tiep khi cham `MAX_TURNS`
- `MAX_RUN_SEGMENTS`: so lan tiep tuc toi da (moi lan toi da `MAX_TURNS`)
- `WORKSPACE_DIR`: thu muc goc ma tools duoc phep truy cap
- `ENABLE_SHELL_TOOL`: `true/false` de bat/tat tool chay shell
- `ENABLE_TAVILY_SEARCH_TOOL`: `true/false` de bat/tat web search qua Tavily
- `TAVILY_API_KEY`: API key cua Tavily (bat buoc neu bat Tavily search)
- `ENABLE_ZYTE_WEB_TOOL`: `true/false` de bat/tat mo/crawl URL qua Zyte
- `ZYTE_API_KEY`: API key cua Zyte (bat buoc neu bat Zyte crawl)
- `VERBOSE_AGENT_LOG`: `true/false` de in log tien trinh tool/agent ra terminal

## 3) Chay agent

```bash
npm start -- "Hay doc cac file va tao tom tat du an"
```

Hoac dung script mau:

```bash
npm run start:task
```

## 4) Chay qua Telegram

1. Tao bot voi `@BotFather` va lay token
2. Dat token vao `.env`:

```bash
TELEGRAM_BOT_TOKEN=xxxxxxxxxx:yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy
```

3. Chay bot:

```bash
npm run start:telegram
```

Lenh Telegram ho tro:

- `/start`: khoi dong bot
- `/reset`: xoa context hoi thoai cua chat hien tai
- `/continue`: tiep tuc neu bot dung vi het `MAX_TURNS`

Bot se gui them message `[progress] ...` trong luc dang goi tools,
va giu trang thai `typing` lien tuc de ban thay bot dang chay.

## 6) Cai dat tren Arch Linux thanh service

Yeu cau: da clone source vao server (vi du `/opt/wsagenta`).

Chay installer:

```bash
cd /opt/wsagenta
sudo bash scripts/install-arch-service.sh /opt/wsagenta
```

Installer se:

- Cai `nodejs`, `npm`, `git`
- Tao user he thong `wsagenta`
- Chay `npm ci --omit=dev`
- Tao file env `/etc/wsagenta.env` (neu chua co)
- Cai systemd unit `wsagenta.service`
- Enable service va start neu du key

Sau do xem log:

```bash
sudo journalctl -u wsagenta.service -f
```

Neu can restart:

```bash
sudo systemctl restart wsagenta.service
```

## 5) Bat tim kiem Internet voi Tavily + crawl voi Zyte

Trong `.env`:

```bash
ENABLE_TAVILY_SEARCH_TOOL=true
TAVILY_API_KEY=your_real_tavily_key
ENABLE_ZYTE_WEB_TOOL=true
ZYTE_API_KEY=your_real_zyte_key
```

Khi bat, agent co them tools:

- `web_search_tavily`: tim ket qua web
- `web_open_zyte`: mo URL va doc noi dung da render

Goi y prompt tren Telegram:

```text
Hay tim 5 bai viet moi nhat ve OpenAI Agents SDK va tom tat nguon chinh.
```

## Tools local dang co

- `list_files`: liet ke file/folder
- `read_file`: doc noi dung file
- `write_file`: ghi file
- `run_shell`: chay lenh shell (chi khi `ENABLE_SHELL_TOOL=true`)
- `web_search_tavily`: tim web qua Tavily (chi khi `ENABLE_TAVILY_SEARCH_TOOL=true`)
- `web_open_zyte`: mo URL qua Zyte (chi khi `ENABLE_ZYTE_WEB_TOOL=true`)

## Cong nghe

- `@openai/agents`: Agent SDK chinh thuc
- `zod`: schema cho function tools
- `node-telegram-bot-api`: ket noi Telegram (polling)
- `Tavily API`: web search ben ngoai
- `Zyte API`: mo/crawl URL de giam block

## Luu y an toan

- Tool file bi gioi han trong `WORKSPACE_DIR`.
- `run_shell` mac dinh tat.
- Luon xem lai output truoc khi ap dung tren du an that.
