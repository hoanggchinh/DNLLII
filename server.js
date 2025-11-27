const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

// Import các utils
const askHandler = require('./ask'); // Đảm bảo file ask.js nằm cùng cấp
const { pool } = require('./db');    // Đảm bảo file db.js nằm cùng cấp
const { hashPassword, comparePassword, generateOTP } = require('./authHelper'); // Đảm bảo file authHelper.js nằm cùng cấp

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// LƯU Ý CHO VERCEL:
// - Không cần app.use(express.static) vì Vercel tự động phục vụ file tĩnh (index.html) từ thư mục gốc.
// - Server này chỉ thuần túy xử lý API.

// ---------------------------------------------------------
// 1. API CHATBOT (RAG)
// ---------------------------------------------------------
app.post('/ask', askHandler);

// ---------------------------------------------------------
// 2. API TÀI KHOẢN (AUTH & OTP)
// ---------------------------------------------------------

// A. Đăng nhập
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // Tìm user
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = result.rows[0];

        if (!user) return res.status(400).json({ success: false, message: "Email chưa đăng ký" });
        if (!user.is_verified) return res.status(400).json({ success: false, message: "Tài khoản chưa xác thực OTP" });

        // Check pass
        if (!user.password_hash) return res.status(400).json({ success: false, message: "Lỗi dữ liệu tài khoản" });

        const isMatch = await comparePassword(password, user.password_hash);
        if (!isMatch) return res.status(400).json({ success: false, message: "Sai mật khẩu" });

        res.json({ success: true, userId: user.id, user: { name: user.email }, message: "Đăng nhập thành công" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "Lỗi Server" });
    }
});

// B. Gửi OTP (Dùng chung cho Đăng ký & Quên mật khẩu)
app.post('/api/send-otp', async (req, res) => {
    try {
        const { email, type } = req.body; // type: 'register' hoặc 'forgot'
        const otp = generateOTP();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // Hết hạn sau 5 phút

        // Kiểm tra user có tồn tại không
        const userCheck = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = userCheck.rows[0];

        if (type === 'register') {
            // Nếu đăng ký: Email phải chưa tồn tại (hoặc chưa verify)
            if (user && user.is_verified) {
                return res.status(400).json({ success: false, message: "Email này đã được sử dụng." });
            }
            // Nếu chưa có user -> Tạo user tạm
            if (!user) {
                await pool.query(
                    `INSERT INTO users (email, otp_code, otp_expires_at, is_verified) VALUES ($1, $2, $3, FALSE)`,
                    [email, otp, expiresAt]
                );
            } else {
                // Có user nhưng chưa verify -> Update lại OTP
                await pool.query(
                    `UPDATE users SET otp_code = $1, otp_expires_at = $2 WHERE email = $3`,
                    [otp, expiresAt, email]
                );
            }
        } else if (type === 'forgot') {
            // Nếu quên mật khẩu: Email bắt buộc phải tồn tại và đã verify
            if (!user || !user.is_verified) {
                return res.status(400).json({ success: false, message: "Email không tồn tại trong hệ thống." });
            }
            // Update OTP mới
            await pool.query(
                `UPDATE users SET otp_code = $1, otp_expires_at = $2 WHERE email = $3`,
                [otp, expiresAt, email]
            );
        }

        // --- GỬI EMAIL (MOCKUP) ---
        console.log(`\n💌 [MOCK EMAIL SERVER]`);
        console.log(`👉 Gửi đến: ${email}`);
        console.log(`👉 Loại: ${type === 'register' ? 'Đăng ký' : 'Quên mật khẩu'}`);
        console.log(`👉 MÃ OTP: ${otp}`);
        console.log(`------------------------\n`);

        res.json({ success: true, message: "Đã gửi mã OTP (Check Console server)" });

    } catch (err) {
        console.error("Lỗi gửi OTP:", err);
        res.status(500).json({ success: false, message: "Lỗi hệ thống khi gửi OTP" });
    }
});

// C. Xác nhận Đăng ký (Register Verify)
app.post('/api/register', async (req, res) => {
    try {
        const { email, password, otp } = req.body;

        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = result.rows[0];

        if (!user) return res.status(400).json({ success: false, message: "Email không hợp lệ (hãy yêu cầu gửi lại OTP)" });

        // Kiểm tra OTP
        if (user.otp_code !== otp) return res.status(400).json({ success: false, message: "Mã OTP không đúng" });
        if (new Date() > new Date(user.otp_expires_at)) return res.status(400).json({ success: false, message: "Mã OTP đã hết hạn" });

        // Hash password và kích hoạt tài khoản
        const hashedPassword = await hashPassword(password);

        await pool.query(
            `UPDATE users SET password_hash = $1, is_verified = TRUE, otp_code = NULL WHERE email = $2`,
            [hashedPassword, email]
        );

        res.json({ success: true, message: "Đăng ký thành công!" });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "Lỗi đăng ký" });
    }
});

// D. Quên mật khẩu - Đặt lại mật khẩu (Reset Password)
app.post('/api/reset-password', async (req, res) => {
    try {
        const { email, otp, newPassword } = req.body;

        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = result.rows[0];

        if (!user) return res.status(400).json({ success: false, message: "Email không tồn tại" });

        // Kiểm tra OTP
        if (user.otp_code !== otp) return res.status(400).json({ success: false, message: "Mã OTP không đúng" });
        if (new Date() > new Date(user.otp_expires_at)) return res.status(400).json({ success: false, message: "Mã OTP đã hết hạn" });

        // Đổi mật khẩu mới
        const hashedPassword = await hashPassword(newPassword);

        await pool.query(
            `UPDATE users SET password_hash = $1, otp_code = NULL WHERE email = $2`,
            [hashedPassword, email]
        );

        res.json({ success: true, message: "Đổi mật khẩu thành công. Hãy đăng nhập lại." });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "Lỗi đổi mật khẩu" });
    }
});

// ---------------------------------------------------------
// 3. API LỊCH SỬ CHAT
// ---------------------------------------------------------
app.get('/api/chats', async (req, res) => {
    try {
        const { userId } = req.query;
        if (!userId) return res.json([]);
        const result = await pool.query('SELECT * FROM chats WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
        res.json(result.rows);
    } catch (err) { res.status(500).json([]); }
});

app.get('/api/messages', async (req, res) => {
    try {
        const { chatId } = req.query;
        if (!chatId) return res.json([]);
        const result = await pool.query('SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at ASC', [chatId]);
        res.json(result.rows);
    } catch (err) { res.status(500).json([]); }
});

// VERCEL HANDLER:
// Export 'app' để Vercel serverless function có thể sử dụng.
// 'app.listen' chỉ dùng khi chạy local (node server.js), trên Vercel đoạn này sẽ được bỏ qua.
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`🚀 Server API đang chạy tại http://localhost:${PORT}`);
    });
}

module.exports = app;