const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const mammoth = require('mammoth');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware для обработки JSON и выдачи статических файлов из папки public
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Инициализация Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('⚠️ Ошибка: SUPABASE_URL и SUPABASE_KEY не заданы в переменных окружения.');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Универсальный SMTP-транспорт (работает с любым почтовым провайдером)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_SECURE === 'true', // true для порта 465, false для 587
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// 1. Эндпоинт генерации и отправки одноразового кода доступа читателю
app.post('/api/request-code', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Укажите Email адрес' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const code = Math.floor(100000 + Math.random() * 900000).toString();

  try {
    // Сохранение или обновление кода доступа в Supabase (таблица access_codes)
    const { error: dbError } = await supabase
      .from('access_codes')
      .upsert(
        { 
          email: cleanEmail, 
          code: code, 
          created_at: new Date().toISOString() 
        }, 
        { onConflict: 'email' }
      );

    if (dbError) {
      console.error('Ошибка сохранения кода в БД:', dbError);
      return res.status(500).json({ error: 'Ошибка базы данных при генерации кода' });
    }

    // Отправка письма с кодом на указанную почту читателя
    await transporter.sendMail({
      from: `"Библиотека Akeront" <${process.env.SMTP_USER}>`,
      to: cleanEmail,
      subject: 'Код доступа к Библиотеке Akeront',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #1a1a1a; color: #ffffff; border-radius: 8px; max-width: 500px; margin: 0 auto;">
          <h2 style="color: #ffffff; border-bottom: 1px solid #333; padding-bottom: 10px;">Цифровая Библиотека Akeront</h2>
          <p style="font-size: 16px; color: #ccc;">Ваш одноразовый код доступа к читальне:</p>
          <div style="background-color: #2a2a2a; padding: 15px; text-align: center; border-radius: 6px; margin: 20px 0;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #0088cc;">${code}</span>
          </div>
          <p style="font-size: 13px; color: #888;">Если вы не запрашивали данный код, просто проигнорируйте это письмо.</p>
        </div>
      `
    });

    return res.json({ success: true, message: 'Код доступа отправлен на ваш Email' });
  } catch (error) {
    console.error('Ошибка при отправке письма через SMTP:', error);
    return res.status(500).json({ error: 'Не удалось отправить письмо. Проверьте параметры SMTP.' });
  }
});

// 2. Эндпоинт загрузки витрины книг с автопарсингом .docx файлов прологов
app.get('/api/books', async (req, res) => {
  try {
    const { data: books, error } = await supabase
      .from('books')
      .select('*');

    if (error) {
      console.error('Ошибка получения книг из Supabase:', error);
      return res.status(500).json({ error: 'Не удалось загрузить каталог из базы' });
    }

    const processedBooks = await Promise.all(
      books.map(async (book) => {
        let prologueHtml = book.description || '';

        // Если в поле prologue_file указано имя .docx файла из бакета akeront-media
        if (book.prologue_file) {
          try {
            const { data: fileData, error: downloadError } = await supabase.storage
              .from('akeront-media')
              .download(book.prologue_file);

            if (!downloadError && fileData) {
              const arrayBuffer = await fileData.arrayBuffer();
              const buffer = Buffer.from(arrayBuffer);
              const parsed = await mammoth.convertToHtml({ buffer });
              prologueHtml = parsed.value;
            } else if (downloadError) {
              console.error(`Ошибка загрузки пролога ${book.prologue_file}:`, downloadError);
            }
          } catch (e) {
            console.error(`Ошибка конвертации docx для ${book.title}:`, e);
          }
        }

        return {
          id: book.id,
          title: book.title,
          cover_url: book.cover_url,
          prologue_html: prologueHtml,
          pdf_url: book.pdf_url,
          created_at: book.created_at
        };
      })
    );

    return res.json(processedBooks);
  } catch (error) {
    console.error('Ошибка сервера при формировании каталога:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Запуск Express сервера
app.listen(PORT, () => {
  console.log(`🚀 Сервер Akeront Library успешно запущен на порту ${PORT}`);
});