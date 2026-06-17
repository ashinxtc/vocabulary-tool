const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineString } = require("firebase-functions/params");
const cors = require("cors")({ origin: true });
const mammoth = require("mammoth");

// 设置全局选项
setGlobalOptions({
  maxInstances: 10,
  region: "us-central1"
});

// 定义参数
const GEMINI_API_KEY = defineString("GEMINI_API_KEY");
const DEEPSEEK_API_KEY = defineString("DEEPSEEK_API_KEY");
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions";

// 辅助函数：调用 Gemini API
async function callGeminiAPI(payload) {
  const apiKey = GEMINI_API_KEY.value();
  const response = await fetch(GEMINI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-goog-api-key": apiKey
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API Error: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

// 辅助函数：调用 DeepSeek API
async function callDeepSeekAPI(messages) {
  const apiKey = DEEPSEEK_API_KEY.value();
  const response = await fetch(DEEPSEEK_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: messages,
      temperature: 0.7,
      max_tokens: 16384
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepSeek API Error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  const content = result.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("DeepSeek returned empty response. Possible content filter or rate limit.");
  }
  return content;
}

// 辅助函数：解析 JSON
function parseGeminiJson(jsonText) {
  if (!jsonText || typeof jsonText !== "string") return null;
  const trimmed = jsonText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  return JSON.parse(trimmed);
}

// Cloud Function (公开访问)
exports.geminiProxy = onRequest({ invoker: "public" }, (req, res) => {
  cors(req, res, async () => {
    // 只允许 POST
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      const { action, data } = req.body;

      switch (action) {
        // 1. 提取文件文字
        case "extractText": {
          const { base64Data, mimeType, fileName } = data;
          if (!base64Data) {
            res.status(400).json({ success: false, error: "Missing base64Data" });
            break;
          }

          // DOCX/DOC 文件：mammoth 提取 + DeepSeek 智能解析（分块处理）
          if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
              || mimeType === 'application/msword'
              || (fileName && /\.docx?$/i.test(fileName))) {
            try {
              const buffer = Buffer.from(base64Data, 'base64');
              const result = await mammoth.extractRawText({ buffer });
              if (!result.value || !result.value.trim()) {
                throw new Error("No text extracted from document");
              }

              const rawText = result.value.trim();

              // 如果提取的文字已经是 english#chinese 格式，直接返回
              const lines = rawText.split('\n').filter(l => l.trim());
              const hashCount = lines.filter(l => l.includes('#')).length;
              if (hashCount > lines.length * 0.5) {
                res.json({ success: true, data: rawText });
                break;
              }

              // 分块处理：每块约 5000 字符，在行边界分割
              const CHUNK_SIZE = 5000;
              const textLines = rawText.split('\n');
              const chunks = [];
              let currentChunk = '';
              for (const line of textLines) {
                if (currentChunk.length + line.length + 1 > CHUNK_SIZE && currentChunk.length > 0) {
                  chunks.push(currentChunk);
                  currentChunk = line;
                } else {
                  currentChunk += (currentChunk ? '\n' : '') + line;
                }
              }
              if (currentChunk.trim()) chunks.push(currentChunk);

              console.log(`Processing ${chunks.length} chunks for docx file`);

              // 并行处理所有分块（最多 5 个并发）
              const allPairs = new Map(); // english.toLowerCase() -> { english, chinese }
              const BATCH_SIZE = 5;
              for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
                const batch = chunks.slice(i, i + BATCH_SIZE);
                const results = await Promise.all(batch.map(async (chunk) => {
                  const messages = [{
                    role: "user",
                    content: `Extract English-Chinese word pairs from this text. Output one pair per line as "English#Chinese". Skip headers, instructions, and non-vocabulary content. Skip purely Chinese or purely English lines. If you see alternating English/Chinese lines, pair them up. Output ONLY the word pairs.

Text:
${chunk}`
                  }];
                  try {
                    const response = await callDeepSeekAPI(messages);
                    return response.split('\n').filter(l => l.trim() && l.includes('#'));
                  } catch (err) {
                    console.error(`Chunk processing failed:`, err.message);
                    return [];
                  }
                }));
                // 合并结果并去重
                for (const chunkLines of results) {
                  for (const line of chunkLines) {
                    const parts = line.split('#').map(s => s.trim());
                    if (parts.length >= 2 && parts[0] && parts[1]) {
                      allPairs.set(parts[0].toLowerCase(), { english: parts[0], chinese: parts[1] });
                    }
                  }
                }
              }

              if (allPairs.size === 0) {
                console.warn("DeepSeek parsing returned no pairs, falling back to raw text");
                res.json({ success: true, data: rawText });
              } else {
                const output = Array.from(allPairs.values()).map(p => `${p.english}#${p.chinese}`).join('\n');
                console.log(`Extracted ${allPairs.size} word pairs from docx`);
                res.json({ success: true, data: output });
              }
            } catch (docxErr) {
              res.status(400).json({ success: false, error: `Word 文档处理失败: ${docxErr.message}` });
            }
            break;
          }

          // 纯文本文件：直接解码
          if (mimeType === 'text/plain' || mimeType === 'text/csv'
              || (fileName && /\.(txt|csv|tsv)$/i.test(fileName))) {
            const text = Buffer.from(base64Data, 'base64').toString('utf-8');
            res.json({ success: true, data: text });
            break;
          }

          // 图片和 PDF：用 Gemini 提取
          const geminiSupportedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp',
            'application/pdf', 'image/heic', 'image/heif'];
          if (!geminiSupportedTypes.includes(mimeType) && !mimeType.startsWith('image/')) {
            res.status(400).json({
              success: false,
              error: `不支持的文件格式 (${mimeType})。支持的格式：图片(JPG/PNG/HEIC)、PDF、TXT、DOCX。`
            });
            break;
          }

          const payload = {
            contents: [{
              parts: [
                { text: "Extract all text from the provided file. If the file contains English words, with or without Chinese translations, list them in a clean format (e.g., one word or 'English#Chinese' pair per line). If no clear word pairs are found, return the raw text content." },
                { inlineData: { mimeType: mimeType, data: base64Data } }
              ]
            }]
          };
          const result = await callGeminiAPI(payload);
          const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) throw new Error("Could not extract text from the file.");
          res.json({ success: true, data: text });
          break;
        }

        // 2. 翻译英文单词
        case "translate": {
          const { words } = data;
          if (!Array.isArray(words) || words.length === 0) {
            res.json({ success: true, data: [] });
            return;
          }
          const payload = {
            contents: [{
              parts: [{
                text: `Translate the following English words to Chinese. Provide the response as a valid JSON array of objects, where each object has 'english' and 'chinese' keys. Words: ${JSON.stringify(words)}`
              }]
            }],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    english: { type: "STRING" },
                    chinese: { type: "STRING" }
                  },
                  required: ["english", "chinese"]
                }
              }
            }
          };
          const result = await callGeminiAPI(payload);
          const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!jsonText) throw new Error("Could not get translations.");
          const parsed = parseGeminiJson(jsonText);
          res.json({ success: true, data: Array.isArray(parsed) ? parsed : [] });
          break;
        }

        // 3. 验证翻译
        case "verify": {
          const { wordsWithChinese } = data;
          const formattedWords = wordsWithChinese.map(w => ({
            english: w.english,
            provided_chinese: w.chinese
          }));
          const payload = {
            contents: [{
              parts: [{
                text: `For each English word and its provided Chinese translation, indicate if the translation is accurate. If not, provide the correct translation. Format the response as a valid JSON array of objects, where each object has 'english', 'provided_chinese', 'is_accurate' (boolean), and 'correct_chinese' (string, only if not accurate). Words: ${JSON.stringify(formattedWords)}`
              }]
            }],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    english: { type: "STRING" },
                    provided_chinese: { type: "STRING" },
                    is_accurate: { type: "BOOLEAN" },
                    correct_chinese: { type: "STRING" }
                  },
                  required: ["english", "provided_chinese", "is_accurate"]
                }
              }
            }
          };
          const result = await callGeminiAPI(payload);
          const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!jsonText) throw new Error("Could not get verification results.");
          res.json({ success: true, data: parseGeminiJson(jsonText) || JSON.parse(jsonText) });
          break;
        }

        // 4. 生成例句 (Gemini)
        case "exampleSentence": {
          const { word } = data;
          const payload = {
            contents: [{
              parts: [{
                text: `Please generate a simple and common English example sentence for the word '${word}'. Immediately after the English sentence, provide its Chinese translation. Format the response as a JSON object with 'englishSentence' and 'chineseSentence' keys.`
              }]
            }],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: {
                type: "OBJECT",
                properties: {
                  englishSentence: { type: "STRING" },
                  chineseSentence: { type: "STRING" }
                },
                required: ["englishSentence", "chineseSentence"]
              }
            }
          };
          const result = await callGeminiAPI(payload);
          const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!jsonText) throw new Error("Could not generate example sentence.");
          res.json({ success: true, data: parseGeminiJson(jsonText) || JSON.parse(jsonText) });
          break;
        }

        // 4b. 生成例句 (DeepSeek - 更便宜，配额更高)
        case "exampleSentenceDeepSeek": {
          const { word: deepseekWord } = data;
          const messages = [
            {
              role: "user",
              content: `Generate a simple and common English example sentence for the word "${deepseekWord}" and provide its Chinese translation. Reply ONLY with a JSON object in this exact format: {"englishSentence": "...", "chineseSentence": "..."}`
            }
          ];
          const deepseekResponse = await callDeepSeekAPI(messages);
          const parsedDeepseek = parseGeminiJson(deepseekResponse);
          if (!parsedDeepseek || !parsedDeepseek.englishSentence) {
            throw new Error("Could not generate example sentence from DeepSeek.");
          }
          res.json({ success: true, data: parsedDeepseek });
          break;
        }

        // 5. 生成单词卡数据
        case "flashcardData": {
          const { word } = data;
          const payload = {
            contents: [{
              parts: [{
                text: `For the English word "${word}", provide the following information:
1. The word with syllable breaks (using a hyphen, e.g., "beau-ti-ful").
2. The primary part of speech (e.g., "noun", "verb", "adjective").
3. The Chinese translation.
4. A simple English example sentence.
5. The Chinese translation of the example sentence.

Format the response as a single, valid JSON object with these exact keys: "syllables", "partOfSpeech", "chinese", "englishSentence", "chineseSentence".`
              }]
            }],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: {
                type: "OBJECT",
                properties: {
                  syllables: { type: "STRING" },
                  partOfSpeech: { type: "STRING" },
                  chinese: { type: "STRING" },
                  englishSentence: { type: "STRING" },
                  chineseSentence: { type: "STRING" }
                },
                required: ["syllables", "partOfSpeech", "chinese", "englishSentence", "chineseSentence"]
              }
            }
          };
          const result = await callGeminiAPI(payload);
          const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!jsonText) throw new Error("Could not generate flashcard data.");
          res.json({ success: true, data: parseGeminiJson(jsonText) || JSON.parse(jsonText) });
          break;
        }

        // 6. 生成选择题干扰项
        case "mcqOptions": {
          const { wordList, allQuizWords } = data;
          const payload = {
            contents: [{
              parts: [{
                text: `For each word in the following list, generate three incorrect multiple-choice options (distractors).
1. One distractor should be a real English word that looks or sounds similar to the original word.
2. The other two distractors should be common, real English words.
3. IMPORTANT: None of the generated distractors should be any of these words: ${JSON.stringify(allQuizWords)}.

Word list: ${JSON.stringify(wordList)}

Provide the response as a single, valid JSON array of objects. Each object must have these exact keys: "original_word" and "distractors" (which is an array of three strings).`
              }]
            }],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    original_word: { type: "STRING" },
                    distractors: {
                      type: "ARRAY",
                      items: { type: "STRING" }
                    }
                  },
                  required: ["original_word", "distractors"]
                }
              }
            }
          };
          const result = await callGeminiAPI(payload);
          const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!jsonText) throw new Error("Could not generate MCQ options.");
          const parsed = parseGeminiJson(jsonText);
          res.json({
            success: true,
            data: Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" ? [parsed] : [])
          });
          break;
        }

        // 7. AI 分析文件结构，建议单词库/子集架构 (DeepSeek)
        case "analyzeStructure": {
          const { text } = data;
          if (!text || text.length < 10) {
            res.json({ success: true, data: { libraryName: "我的单词库", subsets: [{ name: "默认", words: text || "" }] } });
            break;
          }
          // 截取前 8000 字符给 AI 分析（避免 token 过多）
          const truncated = text.length > 8000 ? text.substring(0, 8000) + "\n...(truncated)" : text;
          const messages = [
            {
              role: "user",
              content: `分析以下英语单词学习材料内容。这是一个英语单词列表文件。

请完成以下任务：
1. 识别这是什么类型的词汇表（如：教材单元、考试词汇、主题词汇等）
2. 建议一个合适的单词库名称
3. 如果内容有明显的分组（如按单元、按主题、按字母），则分成多个子集；如果没有明显分组，就作为一个子集
4. 提取所有英文单词和中文翻译，格式为 "English#Chinese"

回复严格的 JSON 格式：
{
  "libraryName": "建议的单词库名称",
  "subsets": [
    {
      "name": "子集名称",
      "words": "word1#中文1\\nword2#中文2\\nword3#中文3"
    }
  ]
}

注意：
- words 字段用换行符 \\n 分隔每个单词
- 每个单词格式为 "English#Chinese"
- 如果文件中没有中文翻译，Chinese 部分留空，如 "word#"
- 子集数量建议 1-10 个，取决于内容结构

文件内容：
${truncated}`
            }
          ];
          const deepseekResponse = await callDeepSeekAPI(messages);
          const parsedStructure = parseGeminiJson(deepseekResponse);
          if (!parsedStructure || !parsedStructure.libraryName || !parsedStructure.subsets) {
            throw new Error("AI could not analyze the file structure.");
          }
          res.json({ success: true, data: parsedStructure });
          break;
        }

        default:
          res.status(400).json({ error: `Unknown action: ${action}` });
      }
    } catch (error) {
      console.error("Error:", error);
      res.status(500).json({
        error: error.message || "Internal server error"
      });
    }
  });
});
