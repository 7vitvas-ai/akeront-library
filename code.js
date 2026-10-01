require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Константы проекта
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const BOT_TOKEN = process.env.BOT_TOKEN || '8930356902:AAF9-vZGinxe_LHjmPsSWjF-YVx29n4xK-A';
const ADMIN_ID = process.env.ADMIN_ID || 7800343425;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'W3G97';
const SECRET_TOKEN = process.env.SECRET_TOKEN || 'MY_AKERONT_SECRET_KEY_2026';
const PAYPAL_EMAIL = process.env.PAYPAL_EMAIL || '7vitvas@gmail.com';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hpihtmgbgkcuibssysto.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Статическая папка с HTML файлами
app.use(express.static(path.join(__dirname, 'public')));

// Хранилище OTP кодов в памяти
const otpCache = new Map();

// Настройка отправки Email
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER || PAYPAL_EMAIL,
    pass: process.env.SMTP_PASS || ''
  }
});

async function sendMail({ to, subject, text, html, replyTo }) {
  try {
    if (!process.env.SMTP_PASS && !process.env.SMTP_USER) {
      console.log(`[EMAIL LOG] Кому: ${to} | Тема: ${subject}\nТекст: ${text || html}`);
      return;
    }
    await transporter.sendMail({
      from: `"Akeront Library" <${process.env.SMTP_USER || PAYPAL_EMAIL}>`,
      to,
      subject,
      text,
      html,
      replyTo
    });
  } catch (err) {
    console.error('Mail Error:', err.message);
  }
}

async function sendTelegramRequest(method, payload) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error('Telegram API Error:', err.message);
  }
}

function cleanBookTitle(filename) {
  if (!filename) return '';
  let name = String(filename).trim();
  name = name.replace(/\.(pdf|mp3|m4a|wav|ogg|mp4|webm|mkv|docx|doc|jpg|jpeg|png|webp)$/gi, '');
  name = name.replace(/\[.*?\]/g, '');
  name = name.replace(/[\s\-_]+пролог[\s\-_]*(аудио|видео|audio|video)?/gi, '');
  name = name.replace(/[\s\-_]+(обложка|cover)$/gi, '');
  return name.trim();
}

function escapeTgHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// -------------------------------------------------------------
// ВЗАИМОДЕЙСТВИЕ С SUPABASE (БД И ХРАНИЛИЩЕ)
// -------------------------------------------------------------

async function getShowcaseCatalog() {
  const { data: books, error } = await supabase
    .from('books')
    .select('*')
    .eq('is_public', true)
    .order('created_at', { ascending: false });

  if (error || !books) {
    console.error('Error fetching showcase:', error);
    return [];
  }

  return books.map(b => ({
    title: b.title,
    slug: b.slug,
    coverUrl: b.cover_url || '',
    description: b.description || 'Описание отсутствует',
    uploadDate: b.created_at ? new Date(b.created_at).toLocaleDateString('ru-RU') : '',
    formats: [
      ...(b.pdf_url ? [{ type: 'pdf', label: 'PDF (Текст)', icon: '📄', driveId: b.slug, slug: b.slug, title: b.title }] : []),
      ...(b.audio_url ? [{ type: 'audio', label: 'Аудио', icon: '🎧', driveId: b.slug, slug: b.slug, title: b.title + ' (Аудио)' }] : [])
    ]
  }));
}

async function getUserBooks(identifier) {
  if (!identifier) return [];
  const searchId = String(identifier).trim().toLowerCase();
  const cleanEmail = searchId.replace(/^email:/i, '').replace(/^tg:/i, '');

  const { data: rights, error } = await supabase
    .from('rights')
    .select('*, books(*)');

  if (error || !rights) return [];

  const userBooks = [];
  for (const r of rights) {
    const rowId = String(r.identifier).trim().toLowerCase();
    const payerEmail = r.payer_email ? String(r.payer_email).trim().toLowerCase() : '';

    if (rowId === searchId || rowId === 'email:' + searchId || rowId === 'tg:' + searchId || (payerEmail && cleanEmail && payerEmail === cleanEmail)) {
      if (r.books) {
        userBooks.push({
          slug: r.books.slug,
          driveId: r.books.slug,
          title: r.books.title,
          type: r.books.pdf_url ? 'pdf' : (r.books.audio_url ? 'audio' : 'other'),
          ext: 'pdf',
          embedUrl: r.books.pdf_url,
          streamUrl: r.books.pdf_url,
          source: r.source,
          date: r.granted_at ? new Date(r.granted_at).toLocaleDateString('ru-RU') : ''
        });
      }
    }
  }
  return userBooks;
}

async function getBookViewerUrl(identifier, targetBook) {
  const userBooks = await getUserBooks(identifier);
  const hasAccess = userBooks.some(b => b.slug === targetBook || b.driveId === targetBook);

  if (!hasAccess) {
    return { success: false, message: 'Доступ к этой версии отсутствует' };
  }

  const { data: book } = await supabase
    .from('books')
    .select('*')
    .eq('slug', targetBook)
    .single();

  if (!book) {
    return { success: false, message: 'Файл произведения не найден в базе данных' };
  }

  return {
    success: true,
    type: book.pdf_url ? 'pdf' : (book.audio_url ? 'audio' : 'other'),
    title: book.title,
    driveId: book.slug,
    embedUrl: book.pdf_url || book.audio_url,
    streamUrl: book.pdf_url || book.audio_url,
    directUrl: book.pdf_url || book.audio_url,
    mimeType: 'application/pdf'
  };
}

async function savePendingRequest(emailOrTg, bookSlug, bookTitle) {
  const targetId = String(emailOrTg).trim().toLowerCase();
  
  const { data: existing } = await supabase
    .from('pending')
    .select('*')
    .eq('identifier', targetId)
    .eq('book_slug', bookSlug)
    .maybeSingle();

  if (!existing) {
    await supabase.from('pending').insert({
      identifier: emailOrTg,
      book_slug: bookSlug,
      status: 'pending',
      followup_sent: false
    });
  }
}

async function removePendingRequest(emailOrTg, bookSlug) {
  const targetId = String(emailOrTg).trim().toLowerCase();
  await supabase
    .from('pending')
    .delete()
    .eq('book_slug', bookSlug)
    .or(`identifier.ilike.${targetId},identifier.ilike.email:${targetId},identifier.ilike.tg:${targetId}`);
}

async function grantAccessToUser(identifier, bookSlug, bookTitle, source, payerEmail) {
  const userBooks = await getUserBooks(identifier);
  const alreadyGranted = userBooks.some(b => b.slug === bookSlug);

  if (!alreadyGranted) {
    await supabase.from('rights').upsert({
      identifier: identifier,
      book_slug: bookSlug,
      source: source || 'promo',
      payer_email: payerEmail || null
    }, { onConflict: 'identifier,book_slug' });
  }

  if (identifier.toUpperCase().startsWith('TG:')) {
    const cleanTgId = identifier.replace(/^TG:/i, '');
    await sendTelegramRequest('sendMessage', {
      chat_id: cleanTgId,
      text: `🎉 Доступ открыт!\n\nВам открыт доступ к произведению «${bookTitle}».\n\nСсылка на личную библиотеку:\n${BASE_URL}/index.html?tg_id=${cleanTgId}`
    });
  } else {
    const cleanEmail = identifier.replace(/^EMAIL:/i, '');
    await sendMail({
      to: cleanEmail,
      subject: `Доступ открыт: «${bookTitle}» — Akeront Library`,
      html: `Здравствуйте!<br><br>Благодарим вас за поддержку проекта Akeront!<br><br>Вам открыт доступ к произведению «${bookTitle}».<br><br>Зайдите в свою библиотеку по ссылке для чтения:<br><a href="${BASE_URL}/index.html?email=${encodeURIComponent(cleanEmail)}">${BASE_URL}/index.html?email=${encodeURIComponent(cleanEmail)}</a><br><br>Приятного чтения!<br><br>С уважением,<br>Губский В.В.`
    });
  }
}

// -------------------------------------------------------------
// ОБРАБОТКА ЗАПРОСОВ И WEBHOOKS
// -------------------------------------------------------------

async function processTelegramRequest(tgId, bookSlug, bookTitle) {
  const cleanTgId = String(tgId).replace(/^TG:/i, '').trim();
  const identifier = 'TG:' + cleanTgId;
  const title = bookTitle || cleanBookTitle(bookSlug);

  const userBooks = await getUserBooks(identifier);
  if (userBooks.some(b => b.slug === bookSlug)) {
    await sendTelegramRequest('sendMessage', {
      chat_id: cleanTgId,
      text: `ℹ️ У вас уже открыт доступ к произведению «<b>${escapeTgHtml(title)}</b>»!\n\n📖 Ваша личная библиотека:\n${BASE_URL}/index.html?tg_id=${cleanTgId}`,
      parse_mode: 'HTML'
    });
    return;
  }

  await savePendingRequest(identifier, bookSlug, title);

  const approvePaymentUrl = `${BASE_URL}/admin/approve?email=${encodeURIComponent(identifier)}&book_id=${encodeURIComponent(bookSlug)}&title=${encodeURIComponent(title)}&source=manual_payment&secret=${SECRET_TOKEN}`;
  const approvePromoUrl = `${BASE_URL}/admin/approve?email=${encodeURIComponent(identifier)}&book_id=${encodeURIComponent(bookSlug)}&title=${encodeURIComponent(title)}&source=promo&secret=${SECRET_TOKEN}`;

  const adminHtmlBody = `
    <div style="font-family: sans-serif; padding: 20px; background: #1a1a1a; color: #ffffff; border-radius: 8px;">
      <h2 style="color: #e0e0e0; margin-top: 0;">📩 Новый запрос доступа из Telegram</h2>
      <p><b>TG ID:</b> ${identifier}</p>
      <p><b>Книга:</b> «${title}» (${bookSlug})</p>
      <hr style="border: 0; border-top: 1px solid #333; margin: 20px 0;">
      <p style="margin-bottom: 15px;"><b>Выберите действие в 1 клик:</b></p>
      <div>
        <a href="${approvePaymentUrl}" style="background-color: #28a745; color: white; padding: 12px 20px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block; margin-right:10px;">💳 Одобрить (Оплата)</a>
        <a href="${approvePromoUrl}" style="background-color: #17a2b8; color: white; padding: 12px 20px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">🎁 Одобрить (Промо)</a>
      </div>
    </div>
  `;

  await sendMail({
    to: PAYPAL_EMAIL,
    subject: `[Akeront Pending TG] Запрос на «${title}» от ${identifier}`,
    html: adminHtmlBody
  });

  const safeTitle = escapeTgHtml(title);
  const msgText = `Здравствуйте!\n\n` +
    `Ваш интерес говорит о том, что вы уже на пути. На пути, который преобразует отчуждение в целостность. И если наши книги помогают вам в этом, то давайте поможем рядом с нами идущим и сделаем проект ещё более доступным для них.\n\n` +
    `Мы будем рады получить от вас любую поддержку в этом общем деле.\n\n` +
    `Для отправки перевода вы можете воспользоваться PayPal:\n` +
    `💳 <b>PayPal:</b> <code>${PAYPAL_EMAIL}</code>\n\n` +
    `⚠️ <b>ВАЖНО ДЛЯ АВТОМАТИЧЕСКОГО ПОЛУЧЕНИЯ ДОСТУПА:</b>\n` +
    `При отправке перевода в поле «Примечание» (Note/Комментарий) обязательно укажите:\n` +
    `1. Ваш Telegram ID: <code>${cleanTgId}</code>\n` +
    `2. Название книги: «<b>${safeTitle}</b>»\n\n` +
    `Да не оскудеет рука дающего, и да не оскорбится рука принимающего.\n\n` +
    `С уважением,\nГубский В.В.`;

  const inlineKeyboard = ADMIN_USERNAME ? [[{ text: '💬 Написать автору', url: `https://t.me/${ADMIN_USERNAME.replace('@', '')}` }]] : undefined;

  await sendTelegramRequest('sendMessage', {
    chat_id: cleanTgId,
    text: msgText,
    parse_mode: 'HTML',
    reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined
  });
}

async function processEmailRequest(email, bookSlug, bookTitle) {
  const cleanEmail = email.trim().toLowerCase();
  const identifier = 'EMAIL:' + cleanEmail;
  const title = bookTitle || cleanBookTitle(bookSlug);

  const userBooks = await getUserBooks(identifier);
  if (userBooks.some(b => b.slug === bookSlug)) {
    await sendMail({
      to: cleanEmail,
      subject: `Доступ уже открыт: «${title}» — Akeront Library`,
      html: `Здравствуйте!<br><br>У вас уже открыт доступ к произведению «${title}».<br><br>Ссылка для чтения в вашей личной библиотеке:<br><a href="${BASE_URL}/index.html?email=${encodeURIComponent(cleanEmail)}">${BASE_URL}/index.html?email=${encodeURIComponent(cleanEmail)}</a><br><br>Приятного чтения!<br><br>С уважением,<br>Губский В.В.`
    });
    return;
  }

  await savePendingRequest(identifier, bookSlug, title);

  const approvePaymentUrl = `${BASE_URL}/admin/approve?email=${encodeURIComponent(identifier)}&book_id=${encodeURIComponent(bookSlug)}&title=${encodeURIComponent(title)}&source=manual_payment&secret=${SECRET_TOKEN}`;
  const approvePromoUrl = `${BASE_URL}/admin/approve?email=${encodeURIComponent(identifier)}&book_id=${encodeURIComponent(bookSlug)}&title=${encodeURIComponent(title)}&source=promo&secret=${SECRET_TOKEN}`;

  const adminHtmlBody = `
    <div style="font-family: sans-serif; padding: 20px; background: #1a1a1a; color: #ffffff; border-radius: 8px;">
      <h2 style="color: #e0e0e0; margin-top: 0;">📩 Новый запрос доступа по Email</h2>
      <p><b>Покупатель:</b> <a style="color: #4da6ff;" href="mailto:${cleanEmail}">${cleanEmail}</a></p>
      <p><b>Книга:</b> «${title}» (${bookSlug})</p>
      <hr style="border: 0; border-top: 1px solid #333; margin: 20px 0;">
      <p style="margin-bottom: 15px;"><b>Выберите действие в 1 клик:</b></p>
      <div>
        <a href="${approvePaymentUrl}" style="background-color: #28a745; color: white; padding: 12px 20px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block; margin-right:10px;">💳 Одобрить (Оплата)</a>
        <a href="${approvePromoUrl}" style="background-color: #17a2b8; color: white; padding: 12px 20px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">🎁 Одобрить (Промо)</a>
      </div>
    </div>
  `;

  await sendMail({
    to: PAYPAL_EMAIL,
    subject: `[Akeront Pending Email] Запрос на «${title}» от ${cleanEmail}`,
    html: adminHtmlBody,
    replyTo: cleanEmail
  });

  const autoReplyBody = `Здравствуйте!\n\n` +
    `Ваш интерес говорит о том, что вы уже на пути. На пути, который преобразует отчуждение в целостность. И если наши книги помогают вам в этом, то давайте поможем рядом с нами идущим и сделаем проект ещё более доступным для них.\n\n` +
    `Мы будем рады получить от вас любую поддержку в этом общем деле.\n\n` +
    `Для отправки перевода вы можете воспользоваться PayPal:\n` +
    `💳 PayPal: ${PAYPAL_EMAIL}\n\n` +
    `ВАЖНО ДЛЯ АВТОМАТИЧЕСКОГО ПОЛУЧЕНИЯ ДОСТУПА:\n` +
    `При отправке перевода в поле «Примечание» (Note/Комментарий) обязательно укажите:\n` +
    `1. Ваш Email: ${cleanEmail}\n` +
    `2. Название книги: «${title}»\n\n` +
    `Да не оскудеет рука дающего, и да не оскорбится рука принимающего.\n\n` +
    `С уважением,\nГубский В.В.`;

  await sendMail({
    to: cleanEmail,
    subject: `Инструкция по поддержке и доступу к «${title}» — Akeront Library`,
    text: autoReplyBody
  });
}

function sendOtpCode(email) {
  const cleanEmail = String(email).trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    return { success: false, message: 'Укажите корректный Email' };
  }
  const code = Math.floor(1000 + Math.random() * 9000).toString();
  otpCache.set('OTP_' + cleanEmail, { code, expires: Date.now() + 600000 });

  sendMail({
    to: cleanEmail,
    subject: 'Код входа в читальный зал Akeront',
    html: `<div style="font-family: sans-serif; padding: 20px; background: #1a1a1a; color: #ffffff;"><h2>Akeront Library</h2><p>Ваш код входа: <b style="font-size: 20px; color: #4da6ff;">${code}</b></p></div>`
  });

  return { success: true };
}

async function verifyOtpAndGetBooks(email, code) {
  const cleanEmail = String(email).trim().toLowerCase();
  const cached = otpCache.get('OTP_' + cleanEmail);

  if (!cached || cached.code !== String(code).trim() || Date.now() > cached.expires) {
    return { success: false, message: 'Неверный или просроченный код' };
  }

  otpCache.delete('OTP_' + cleanEmail);
  const identifier = 'EMAIL:' + cleanEmail;
  const books = await getUserBooks(identifier);

  return { success: true, identifier, books };
}

// -------------------------------------------------------------
// МАРШРУТЫ И АПИ СЕРВЕРА
// -------------------------------------------------------------

app.get('/admin/approve', async (req, res) => {
  const { email, book_id, title, source, payer_email, secret } = req.query;

  if (secret !== SECRET_TOKEN) {
    return res.status(403).send("<h2 style='color:red;'>Ошибка: Неверный секретный токен!</h2>");
  }

  const identifier = email;
  const bookSlug = book_id;
  const bookTitle = title || cleanBookTitle(bookSlug);
  const grantSource = source || 'manual_approval';

  await grantAccessToUser(identifier, bookSlug, bookTitle, grantSource, payer_email || '');
  await removePendingRequest(identifier, bookSlug);

  res.send(`
    <div style="font-family:sans-serif; padding:40px; text-align:center; background:#111; color:#fff; height:100vh;">
      <h1 style="color:#4CAF50;">✅ Доступ успешно открыт!</h1>
      <p><b>Идентификатор:</b> ${escapeTgHtml(identifier)}</p>
      <p><b>Произведение:</b> «${escapeTgHtml(bookTitle)}»</p>
      <p><b>Тип выдачи:</b> ${escapeTgHtml(grantSource)}</p>
    </div>
  `);
});

// Единая точка обработки API-запросов (замена google.script.run)
app.post('/api/action', async (req, res) => {
  try {
    const data = req.body;
    const action = data.action;

    if (action === 'getShowcaseCatalog' || action === 'sync_showcase') {
      const catalog = await getShowcaseCatalog();
      return res.json(catalog);
    }

    if (action === 'getUserBooks') {
      const books = await getUserBooks(data.identifier);
      return res.json(books);
    }

    if (action === 'sendOtpCode' || action === 'send_otp') {
      const result = sendOtpCode(data.email);
      return res.json(result);
    }

    if (action === 'verifyOtpAndGetBooks' || action === 'verify_otp') {
      const result = await verifyOtpAndGetBooks(data.email, data.code);
      return res.json(result);
    }

    if (action === 'getBookViewerUrl' || action === 'get_viewer_url') {
      const result = await getBookViewerUrl(data.identifier, data.book_id || data.book_slug);
      return res.json(result);
    }

    if (action === 'processTelegramRequest' || action === 'request_tg_access') {
      await processTelegramRequest(data.tg_id, data.book_id || data.book_slug, data.book_title);
      return res.json({ success: true });
    }

    if (action === 'processEmailRequest' || action === 'request_email_access') {
      await processEmailRequest(data.email, data.book_id || data.book_slug, data.book_title);
      return res.json({ success: true });
    }

    if (action === 'getPdfContentBase64') {
      const { data: book } = await supabase.from('books').select('pdf_url').eq('slug', data.fileId).single();
      if (book && book.pdf_url) {
        const fileRes = await fetch(book.pdf_url);
        const arrayBuffer = await fileRes.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString('base64');
        return res.json(base64);
      }
      return res.status(404).json({ error: 'Файл не найден' });
    }

    res.json({ success: false, error: 'Unknown action' });
  } catch (err) {
    console.error('API Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Telegram Webhook
app.post('/telegram/webhook', async (req, res) => {
  try {
    const update = req.body;
    if (!update || !update.message) return res.send('OK');

    const chat = update.message.chat;
    if (chat.type !== 'private') return res.send('OK');

    const chatId = chat.id;
    const userId = update.message.from ? update.message.from.id : chatId;
    const userName = update.message.from ? (update.message.from.username || update.message.from.first_name) : chatId;
    const text = update.message.text ? update.message.text.trim() : '';

    if (text.startsWith('/start')) {
      const catalogUrl = `${BASE_URL}/showcase.html?tg_id=${userId}`;
      const libraryUrl = `${BASE_URL}/index.html?tg_id=${userId}`;

      await sendTelegramRequest('sendMessage', {
        chat_id: chatId,
        text: '📖 Добро пожаловать в читальный зал Akeront!\n\nВыберите действие в меню ниже:',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📚 Каталог произведений', url: catalogUrl }],
            [{ text: '📖 Моя личная библиотека', url: libraryUrl }]
          ]
        }
      });
    } else if (text) {
      await sendMail({
        to: PAYPAL_EMAIL,
        subject: `💬 Сообщение в бот от @${userName} (ID: ${userId})`,
        text: `Пользователь TG @${userName} (ID: ${userId}) написал:\n\n"${text}"`
      });

      await sendTelegramRequest('sendMessage', {
        chat_id: chatId,
        text: '✅ Ваше сообщение передано автору!'
      });
    }
  } catch (err) {
    console.error('Webhook error:', err);
  }
  res.send('OK');
});

// Дожим через 24 часа (фоновая задача)
setInterval(async () => {
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: pendingList } = await supabase
      .from('pending')
      .select('*, books(title)')
      .eq('followup_sent', false)
      .lte('created_at', oneDayAgo);

    if (pendingList && pendingList.length > 0) {
      for (const row of pendingList) {
        const identifier = String(row.identifier).trim();
        const bookTitle = row.books?.title || row.book_slug;

        if (identifier.toUpperCase().startsWith('TG:')) {
          const cleanTgId = identifier.replace(/^TG:/i, '');
          const safeTitle = escapeTgHtml(bookTitle);

          const followUpText = `Здравствуйте!\n\n` +
            `Вчера вы запрашивали доступ к «<b>${safeTitle}</b>».\n\n` +
            `Если вам неудобно оплатить через PayPal, вы можете перевести на карту или воспользоваться другими вариантами.\n\n` +
            `Нажмите кнопку ниже или просто отправьте ответное сообщение в этот чат:`;

          const inlineKeyboard = ADMIN_USERNAME ? [[{ text: '💬 Написать автору', url: `https://t.me/${ADMIN_USERNAME.replace('@', '')}` }]] : undefined;

          await sendTelegramRequest('sendMessage', {
            chat_id: cleanTgId,
            text: followUpText,
            parse_mode: 'HTML',
            reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined
          });
        } else {
          const cleanEmail = identifier.replace(/^EMAIL:/i, '');
          await sendMail({
            to: cleanEmail,
            subject: `Альтернативная оплата доступа к «${bookTitle}»`,
            text: `Здравствуйте!\n\nВчера вы запрашивали доступ к «${bookTitle}».\nЕсли PayPal неудобен, напишите в ответ на это письмо для получения реквизитов карты.`
          });
        }

        await supabase.from('pending').update({ followup_sent: true }).eq('id', row.id);
      }
    }
  } catch (e) {
    console.error('Followup task error:', e);
  }
}, 30 * 60 * 1000); // Каждые 30 минут

app.listen(PORT, () => {
  console.log(`🚀 Сервер Akeront Library запущен на порту ${PORT}`);
});