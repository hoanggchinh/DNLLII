// Import các thư viện cần thiết
const { Pinecone } = require("@pinecone-database/pinecone");
const { PineconeStore } = require("@langchain/pinecone");
const { GoogleGenerativeAIEmbeddings, ChatGoogleGenerativeAI } = require("@langchain/google-genai");
const { PromptTemplate } = require("@langchain/core/prompts");

// Cấu hình: Tên Index Pinecone của bạn
const PINECONE_INDEX_NAME = "rag-do-an";

// Hàm handler chính của Vercel
module.exports = async (req, res) => {
    // Xử lý CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Chỉ cho phép phương thức POST
    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        // 1. Lấy câu hỏi từ body của request
        const { question } = req.body;
        if (!question || question.trim() === '') {
            return res.status(400).json({ error: "Question is required and cannot be empty" });
        }

        // 2. Lấy API keys từ Biến Môi Trường của Vercel
        const googleApiKey = process.env.GEMINI_API_KEY;
        const pineconeApiKey = process.env.PINECONE_API_KEY;

        if (!googleApiKey || !pineconeApiKey) {
            console.error("[ERROR] Missing API keys");
            return res.status(500).json({
                error: "API keys not configured (GEMINI_API_KEY or PINECONE_API_KEY missing)"
            });
        }

        console.log("[INFO] Initializing services...");

        // 3. Khởi tạo các dịch vụ
        const pinecone = new Pinecone({ apiKey: pineconeApiKey });
        const pineconeIndex = pinecone.Index(PINECONE_INDEX_NAME);

        const embeddings = new GoogleGenerativeAIEmbeddings({
            model: "models/text-embedding-004",
            apiKey: googleApiKey,
        });

        const vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
            pineconeIndex,
        });

        const model = new ChatGoogleGenerativeAI({
            model: "gemini-1.5-flash",
            apiKey: googleApiKey,
            temperature: 0.3,
        });

        // 4. Tạo Prompt Template
        const promptTemplate = PromptTemplate.fromTemplate(`
Bạn là một trợ lý AI hữu ích của trường đại học.
Nhiệm vụ của bạn là trả lời câu hỏi của sinh viên dựa trên các tài liệu nội bộ của trường.
Chỉ sử dụng thông tin từ "NGỮ CẢNH" được cung cấp.
Nếu "NGỮ CẢNH" không chứa thông tin để trả lời, hãy nói: "Xin lỗi, tôi không tìm thấy thông tin này trong tài liệu."
Không được bịa đặt thông tin.

NGỮ CẢNH:
{context}

CÂU HỎI:
{question}

CÂU TRẢ LỜI (bằng tiếng Việt):
        `);

        // 5. Thực thi RAG
        console.log("[INFO] Searching for relevant documents...");

        const retriever = vectorStore.asRetriever(4);
        const relevantDocs = await retriever.invoke(question);

        // Kiểm tra nếu không tìm thấy documents
        if (!relevantDocs || relevantDocs.length === 0) {
            console.log("[INFO] No relevant documents found");
            return res.status(200).json({
                answer: "Xin lỗi, tôi không tìm thấy thông tin liên quan trong tài liệu của trường."
            });
        }

        const formatContext = (docs) => docs.map((doc) => doc.pageContent).join("\n\n");
        const context = formatContext(relevantDocs);

        console.log(`[INFO] Found ${relevantDocs.length} relevant documents. Generating answer...`);

        // 6. Tạo câu trả lời
        const prompt = await promptTemplate.format({ context, question });
        const response = await model.invoke(prompt);

        // Xử lý response an toàn
        let answerText;
        if (typeof response === 'string') {
            answerText = response;
        } else if (response.content) {
            answerText = response.content;
        } else if (response.text) {
            answerText = response.text;
        } else {
            console.error("[ERROR] Unexpected response format:", response);
            answerText = "Xin lỗi, đã xảy ra lỗi khi tạo câu trả lời.";
        }

        console.log("[INFO] Answer generated successfully");

        // Gửi câu trả lời về cho frontend
        res.status(200).json({ answer: answerText });

    } catch (error) {
        console.error("[ERROR] Processing request:", error.message);
        console.error("[ERROR] Stack trace:", error.stack);

        res.status(500).json({
            error: "An error occurred while processing your request",
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};