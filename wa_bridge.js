    // === WhatsApp Bridge ===
    // Связующее звено между Django и WhatsApp (через whatsapp-web.js)

    import express from "express";
    import fetch from "node-fetch";
    import QRCode from "qrcode";
    import cors from "cors";
    import pkg from "whatsapp-web.js";
    const { Client, LocalAuth } = pkg;

    const app = express();
    app.use(cors());
    app.use(express.json());

    const PORT = 3001;

    // Django API URLs
    const djangoIncoming = "http://127.0.0.1:8000/api/wa/message_in/"; // входящие
    const djangoSend = "http://127.0.0.1:8000/api/wa/send/"; // (резерв)

    const clients = {}; // username -> { client, qr, ready }

    // ==========================
    // Функция создания клиента
    // ==========================
    function createClient(username) {
        if (clients[username]) return clients[username];

        console.log(`\n[🧩] Создаю нового клиента для пользователя ${username}`);
        const client = new Client({
            authStrategy: new LocalAuth({ clientId: username }),
            puppeteer: {
                headless: true,
                args: [
                    "--no-sandbox",
                    "--disable-gpu",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                ],
            },
        });

        // QR-код
        client.on("qr", async qr => {
            console.log(`[QR] Новый QR для ${username}`);
            try {
                const dataUrl = await QRCode.toDataURL(qr); // <-- создаёт готовый PNG в base64
                clients[username].qr = dataUrl;
            } catch (err) {
                console.error(`[❌] Ошибка генерации QR: ${err.message}`);
            }
        });


        // Аутентификация
        client.on("authenticated", () => {
            console.log(`[🔐] ${username}: аутентификация прошла успешно`);
        });

        client.on("ready", () => {
            console.log(`[✅] ${username}: клиент готов к работе`);
            clients[username].ready = true;
            clients[username].qr = null; // QR больше не нужен
        });

        // Ошибки
        client.on("auth_failure", msg => {
            console.error(`[❌] ${username}: ошибка авторизации (${msg})`);
        });

        client.on("disconnected", reason => {
            console.log(`[⚠️] ${username}: отключен (${reason})`);
            clients[username].ready = false;
            clients[username].qr = null;
        });

        // Входящее сообщение
        client.on("message", async msg => {
            console.log(`[💬] ${username} <- ${msg.from}: ${msg.body}`);
            try {
                const payload = {
                    user: username,
                    from: msg.from,
                    body: msg.body,
                    timestamp: msg.timestamp,
                };
                const res = await fetch(djangoIncoming, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
                if (!res.ok) throw new Error(`Django response ${res.status}`);
                console.log(`[➡️] Отправлено в Django (${msg.from})`);
            } catch (err) {
                console.error(`[❌] Ошибка при отправке в Django: ${err.message}`);
            }
        });

        client.initialize();

        clients[username] = { client, qr: null, ready: false };
        return clients[username];
    }

    // ==========================
    // API эндпоинты
    // ==========================

    // Получить QR-код
    app.get("/qr", async (req, res) => {
        const username = req.query.user;
        if (!username) return res.json({ error: "missing user" });

        const clientObj = createClient(username);
        if (clientObj.ready) {
            return res.json({ status: "connected" });
        }

        if (clientObj.qr) {
            // Возвращаем оригинальную строку QR (не base64-картинку!)
            return res.json({ qr: clientObj.qr });
        } else {
            return res.json({ error: "QR not ready" });
        }
    });

    // Проверка статуса
    app.get("/status", (req, res) => {
        const username = req.query.user;
        if (!username) return res.json({ error: "missing user" });

        const clientObj = clients[username];
        const connected = !!(clientObj && clientObj.ready);
        res.json({ connected });
    });

    // Отправка сообщения из Django
    app.post("/send", async (req, res) => {
        const { user, to, text } = req.body;
        if (!user || !to || !text) return res.json({ error: "missing params" });

        const clientObj = clients[user];
        if (!clientObj || !clientObj.ready)
            return res.json({ error: "client not connected" });

        try {
            const sent = await clientObj.client.sendMessage(to, text);
            console.log(`[📤] ${user} -> ${to}: ${text}`);
            res.json({ success: true, id: sent.id.id });
        } catch (err) {
            console.error(`[❌] Ошибка отправки: ${err.message}`);
            res.json({ error: err.message });
        }
    });

    // ==========================
    // Запуск сервера
    // ==========================
    app.listen(PORT, () =>
        console.log(`🚀 WhatsApp Bridge запущен на http://localhost:${PORT}`)
    );
