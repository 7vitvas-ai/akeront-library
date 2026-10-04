const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const mammoth = require('mammoth');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Транспорт Resend SMTP
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.resend.com',
  port: parseInt(process.env.SMTP_PORT || '465', 10),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER || 'resend',
    pass: process.env.SMTP_PASS
  }
});

// 1. Отправка одноразового кода на Email
app.post('/api/request-code', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Укажите Email' });

  const cleanEmail = email.trim().toLowerCase();
  const code = Math.floor(100000 + Math.random() * 900000).toString();

  try {
    const { error: dbError } = await supabase
      .from('access_codes')
      .upsert(
        { email: cleanEmail, code: code, created_at: new Date().toISOString() },
        { onConflict: 'email' }
      );

    if (dbError) throw dbError;

    // Resend требует отправителя onboarding@resend.dev на бесплатном тарифе
    await transporter.sendMail({
      from: 'Библиотека Akeront <onboarding@resend.dev>',
      to: cleanEmail,
      subject: 'Код доступа к Читальне Akeront',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #1a1a1a; color: #ffffff; border-radius: 8px; max-width: 450px;">
          <h2>Библиотека Akeront</h2>
          <p>Ваш одноразовый код доступа:</p>
          <div style="background-color: #2a2a2a; padding: 15px; text-align: center; border-radius: 6px;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #0284c7;">${code}</span>
          </div>
        </div>
      `
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Ошибка SMTP/БД:', err);
    return res.status(500).json({ error: 'Не удалось отправить код' });
  }
});

// 2. Проверка кода доступа
app.post('/api/verify-code', async (req, res) => {
  const { email, code } = req.body;
  const cleanEmail = (email || '').trim().toLowerCase();

  const { data, error } = await supabase
    .from('access_codes')
    .select('*')
    .eq('email', cleanEmail)
    .eq('code', code.trim())
    .single();

  if (error || !data) {
    return res.status(401).json({ error: 'Неверный код доступа' });
  }

  return res.json({ success: true });
});

// 3. Получение каталога витрины с парсингом .docx из prologue_url
app.get('/api/books', async (req, res) => {
  try {
    const { data: books, error } = await supabase.from('books').select('*');
    if (error) throw error;

    const processedBooks = await Promise.all(
      books.map(async (book) => {
        let prologueHtml = book.description || '';

        // Берем имя .docx файла из prologue_url
        if (book.prologue_url) {
          try {
            const fileName = book.prologue_url.split('/').pop();
            const { data: fileData, error: downloadError } = await supabase.storage
              .from('akeront-media')
              .download(fileName);

            if (!downloadError && fileData) {
              const arrayBuffer = await fileData.arrayBuffer();
              const parsed = await mammoth.convertToHtml({ buffer: Buffer.from(arrayBuffer) });
              if (parsed.value) prologueHtml = parsed.value;
            }
          } catch (e) {
            console.error(`Ошибка конвертации .docx (${book.title}):`, e);
          }
        }

        return {
          id: book.id,
          title: book.title,
          cover_url: book.cover_url,
          prologue_html: prologueHtml,
          pdf_url: book.pdf_url
        };
      })
    );

    return res.json(processedBooks);
  } catch (err) {
    console.error('Ошибка сервера:', err);
    return res.status(500).json({ error: 'Ошибка загрузки книг' });
  }
});

app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));