// services/ocrService.js
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { log } = require("../utils/helpers");

// --- Configuration ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error("FATAL ERROR: GEMINI_API_KEY is not defined in environment variables.");
}

let genAI;
let model;

try {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
    log("Google Generative AI initialized successfully.");
} catch (error) {
    console.error("Failed to initialize Google Generative AI:", error);
}


/**
 * Extracts structured data from an image using a specific prompt.
 * @param {Buffer} imageBuffer The buffer of the image to analyze.
 * @param {string} prompt The detailed prompt instructing the AI what to extract.
 * @returns {Promise<{success: boolean, data: object | null, error: string | null}>} A promise that resolves to the extracted JSON object or an error.
 */
const extractDataFromImage = async (imageBuffer, prompt) => {
    if (!model) {
        return { success: false, data: null, error: "Gemini AI model is not initialized. Check API Key and logs." };
    }

    try {
        log("Sending image to Gemini for data extraction...");
        const imagePart = {
            inlineData: {
                data: imageBuffer.toString("base64"),
                mimeType: "image/jpeg", // Using JPEG as a robust default
            },
        };

        const result = await model.generateContent([prompt, imagePart]);
        const response = await result.response;
        const text = response.text();

        log("Received response from Gemini:", text);

        // Clean the response to get a valid JSON string
        // The model sometimes wraps the JSON in ```json ... ``` or just ```
        const jsonMatch = text.match(/```(json)?\n([\s\S]*?)\n```/);
        const jsonString = jsonMatch ? jsonMatch[2] : text;

        try {
            const data = JSON.parse(jsonString);
            return { success: true, data, error: null };
        } catch (parseError) {
            log("Error parsing JSON response from Gemini", { error: parseError.message, response: text });
            return { success: false, data: null, error: "I couldn't understand the structure of the text in the image. Please try a clearer picture." };
        }

    } catch (error) {
        log("An error occurred with the Gemini API call", { error: error.message });
        return { success: false, data: null, error: "An error occurred while communicating with the AI model." };
    }
};

module.exports = { extractDataFromImage };
