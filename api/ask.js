// Import các thư viện cần thiết
// (Đã xóa các import không dùng tới)
const { Pinecone } = require("@pinecone-database/pinecone");
const { PineconeStore } = require("@langchain/pinecone");
const { GoogleGenerativeAiEmbeddings, ChatGoogleGenerativeAI } = require("@langchain/google-genai");
const { PromptTemplate } = require("@langchain/core/prompts");

// Cấu hình: Tên Index Pinecone của bạn
const PINECONE_INDEX_NAME = "rag-do-an";

// Hàm handler chính của Vercel
module.exports = async (req, res) => {
    // Chỉ cho phép phương thức POST
    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        // 1. Lấy câu hỏi từ body của request
        const { question } = req.body;
        if (!question) {
            return res.status(400).json({ error: "Question is required" });
        }

        // 2. Lấy API keys từ Biến Môi Trường của Vercel
        // (Đảm bảo bạn đã sửa tên biến trên Vercel thành GEMINI_API_KEY)
        const googleApiKey = process.env.GEMINI_API_KEY;
        const pineconeApiKey = process.env.PINECONE_API_KEY;

        if (!googleApiKey || !pineconeApiKey) {
            return res.status(500).json({ error: "API keys not configured (GEMINI_API_KEY or PINECONE_API_KEY missing)" });
        }

        // 3. Khởi tạo các dịch vụ
        const pinecone = new Pinecone({ apiKey: pineconeApiKey });
        const pineconeIndex = pinecone.Index(PINECONE_INDEX_NAME);

        const embeddings = new GoogleGenerativeAiEmbeddings({
            model: "models/text-embedding-004",
            apiKey: googleApiKey,
        });

        const vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
            pineconeIndex,
        });

        // >>>>> LỖI 404 ĐÃ SỬA Ở ĐÂY:
        const model = new ChatGoogleGenerativeAI({
            model: "gemini-1.5-flash", // Bỏ "-latest"
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

        // 5. (Mục 5 cũ đã bị xóa vì không dùng đến)

        // 6. Thực thi RAG theo cách thủ công (như log của bạn)
        console.log("Initializing services..."); // (Log mới)

        const retriever = vectorStore.asRetriever(4);
        const formatContext = (docs) => docs.map((doc) => doc.pageContent).join("\n\n");

        console.log("Searching for relevant documents...");

        // Bước 1: Tìm kiếm documents
        const relevantDocs = await retriever.invoke(question);
        const context = formatContext(relevantDocs);

        console.log(`Found ${relevantDocs.length} relevant documents. Generating answer...`);

        // Bước 2: Tạo câu trả lời
        const prompt = await promptTemplate.format({ context, question });
        // 'model.invoke(prompt)' sẽ trả về một object (AIMessage)
        const answer = await model.invoke(prompt);

        console.log("Answer generated.");

        // Gửi câu trả lời về cho frontend
        // (Lấy nội dung từ object AIMessage)
        res.status(200).json({ answer: answer.content });

    } catch (error) {
        console.error("Error processing request:", error);
        res.status(500).json({ error: "An error occurred: " + error.message });
    }
};