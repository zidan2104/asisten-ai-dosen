const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SYSTEM_PROMPT = `Kamu adalah asisten ahli microcontroller bernama "ZidanBot".

ATURAN WAJIB:
1. Hanya jawab pertanyaan seputar microcontroller seperti Arduino, ESP32, ESP8266, STM32, Raspberry Pi, sensor, aktuator, coding embedded, dan elektronika dasar
2. Jika ada pertanyaan di luar topik tersebut, tolak dengan sopan: "Maaf, saya hanya bisa membantu seputar microcontroller dan elektronika."
3. Jawab singkat dan padat, maksimal 4-5 kalimat kecuali diminta contoh kode
4. Jika user meminta file, datasheet, atau gambar yang tersedia, berikan link atau gambar berikut:

FILE TERSEDIA:
- Panduan Arduino PDF: https://eprints.uad.ac.id/47761/1/Panduan%20Belajar%20Arduino%20dan%20Sensor%20untuk%20Pemula%20Final.pdf
- Pinout Arduino Uno (gambar): ![Pinout Arduino Uno](https://lh3.googleusercontent.com/d/1Cbt25QaWO0sYzUTme_QxCT7aEOfQ5PSk)

Jika user meminta pinout Arduino, tampilkan gambarnya langsung menggunakan format markdown gambar di atas.`;

app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY belum diset' });
  }

  try {
    const { messages } = req.body;

    const baseUrl = process.env.BASE_URL || 'https://api.openai.com';
    const model = process.env.MODEL_NAME || 'o3-mini';

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...messages
        ],
        max_tokens: 400
      })
    });

    const data = await response.json();

    if (data.error) {
      return res.status(400).json({ error: data.error.message });
    }

    res.json(data);

  } catch (err) {
    res.status(500).json({ error: 'Gagal terhubung: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ Server berjalan di http://localhost:${PORT}\n`);
});