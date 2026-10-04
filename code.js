const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const mammoth = require('mammoth');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Инициализация Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('⚠️ SUPABASE_URL или SUPABASE_KEY не заданы!');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// SMTP Транспорт для Resend
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.resend.com',
  port: parseInt(process.env.SMTP_PORT || '465', 10),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER || 'resend',
    pass: process.env.SMTP_PASS
  }
});

// 1. Запрос кода доступа
app.post('/api/request-code', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Укажите Email адрес' });

  const cleanEmail = email.trim().toLowerCase();
  const code = Math.floor(100000 + Math.random() * 900000).toString();

  try {
    // Сохраняем код в таблицу access_codes
    const { error: dbError } = await supabase
      .from('access_codes')
      .upsert(
        { email: cleanEmail, code: code, created_at: new Date().toISOString() },
        { onConflict: 'email' }
      );

    if (dbError) {
      console.error('❌ Ошибка записи в базу Supabase (access_codes):', dbError);
      return res.status(500).json({ error: `Ошибка базы данных: ${dbError.message}` });
    }

    const mailSender = process.env.SMTP_FROM || 'onboarding@resend.dev';

    // Отправляем письмо через Resend
    await transporter.sendMail({
      from: `Библиотека Akeront <${mailSender}>`,
      to: cleanEmail,
      subject: 'Код доступа к Читальне Akeront',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 25px; background-color: #0f172a; color: #ffffff; border-radius: 12px; max-width: 480px; margin: 0 auto; border: 1px solid #334155;">
          <h2 style="color: #38bdf8; margin-top: 0;">Библиотека Akeront</h2>
          <p style="color: #cbd5e1; font-size: 15px;">Ваш одноразовый код авторизации:</p>
          <div style="background-color: #1e293b; padding: 18px; text-align: center; border-radius: 8px; margin: 20px 0; border: 1px solid #475569;">
            <span style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #0284c7;">${code}</span>
          </div>
          <p style="font-size: 12px; color: #64748b; margin-bottom: 0;">Если вы не запрашивали доступ, проигнорируйте письмо.</p>
        </div>
      `
    });

    console.log(`✅ Код ${code} успешно отправлен на ${cleanEmail}`);
    return res.json({ success: true, message: 'Код отправлен' });

  } catch (err) {
    console.error('❌ Ошибка отправки почты через SMTP:', err);
    return res.status(500).json({ error: `Ошибка отправки письма: ${err.message}` });
  }
});

// 2. Проверка кода доступа
app.post('/api/verify-code', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Неполные данные' });

  const cleanEmail = email.trim().toLowerCase();
  const cleanCode = code.trim();

  try {
    const { data, error } = await supabase
      .from('access_codes')
      .select('*')
      .eq('email', cleanEmail)
      .eq('code', cleanCode)
      .single();

    if (error || !data) {
      return res.status(401).json({ error: 'Неверный или устаревший код' });
    }

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Ошибка проверки кода' });
  }
});

// 3. Каталог книг (Строки берутся НАПРЯМУЮ из БД без любых изменений)
app.get('/api/books', async (req, res) => {
  try {
    const { data: books, error } = await supabase.from('books').select('*');
    if (error) throw error;

    const processedBooks = await Promise.all(
      books.map(async (book) => {
        let prologueHtml = book.description || '';

        // Загрузка .docx напрямую по точному URL из базы
        if (book.prologue_url && book.prologue_url.trim().length > 0) {
          try {
            const docxResponse = await fetch(book.prologue_url.trim());
            if (docxResponse.ok) {
              const arrayBuffer = await docxResponse.arrayBuffer();
              const parsed = await mammoth.convertToHtml({ buffer: Buffer.from(arrayBuffer) });
              if (parsed.value) {
                prologueHtml = parsed.value;
              }
            } else {
              console.warn(`Не удалось загрузить .docx по адресу: ${book.prologue_url}`);
            }
          } catch (e) {
            console.error(`Ошибка Mammoth для ${book.title}:`, e);
          }
        }

        return {
          id: book.id,
          title: book.title,
          cover_url: book.cover_url, // Берутся точные данные из поля
          prologue_html: prologueHtml,
          pdf_url: book.pdf_url       // Берутся точные данные из поля
        };
      })
    );

    return res.json(processedBooks);
  } catch (err) {
    console.error('Ошибка сервера при получении каталога:', err);
    return res.status(500).json({ error: 'Не удалось загрузить каталог' });
  }
});

app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));