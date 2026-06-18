const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineString } = require("firebase-functions/params");
const cors = require("cors")({ origin: true });
const mammoth = require("mammoth");

// 设置全局选项
setGlobalOptions({
  maxInstances: 10,
  region: "us-central1",
  timeoutSeconds: 540
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
      temperature: 0,
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

// 多策略本地解析（确定性，不调用 AI）
function localParseWords(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  if (lines.length === 0) return [];

  // 策略 1: # 分隔符
  const hashLines = lines.filter(l => l.includes('#'));
  if (hashLines.length > lines.length * 0.3) {
    return hashLines.map(l => {
      const parts = l.split('#').map(s => s.trim());
      if (parts.length >= 2 && parts[0] && parts[1]) return { english: parts[0], chinese: parts[1] };
      return null;
    }).filter(Boolean);
  }

  // 策略 2: Tab 分隔
  const tabLines = lines.filter(l => l.includes('\t'));
  if (tabLines.length > lines.length * 0.3) {
    return tabLines.map(l => {
      const parts = l.split('\t').map(s => s.trim());
      if (parts.length >= 2 && parts[0] && parts[1]) return { english: parts[0], chinese: parts[1] };
      return null;
    }).filter(Boolean);
  }

  // 策略 3: POS 标签格式 (word POS. chinese) + 补充混合行策略
  const posResults = [];
  const posMatchedIndices = new Set();
  const singleLetterHeaders = /^[A-Z]$/;
  const posTagPattern = /\b(modal|abbr|adj|adv|conj|int|num|prep|pron|art|vt|vi|n|v)\.\s/i;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (singleLetterHeaders.test(line)) continue;
    const match = line.match(posTagPattern);
    if (match && match.index > 0) {
      const english = line.substring(0, match.index).trim();
      let rest = line.substring(match.index);
      rest = rest.replace(/(?:modal|abbr|adj|adv|conj|int|num|prep|pron|art|vt|vi|n|v)\.\s*/gi, '').trim();
      if (english && rest && /[一-鿿㐀-䶿]/.test(rest)) {
        posResults.push({ english, chinese: rest });
        posMatchedIndices.add(i);
      }
    }
  }
  if (posResults.length > lines.length * 0.3) {
    // POS 解析成功，但对未匹配的行再跑一次混合行策略补充
    const hasCJK = (s) => /[一-鿿㐀-䶿]/.test(s);
    const hasLatin = (s) => /[a-zA-Z]/.test(s);
    const extraResults = [];
    for (let i = 0; i < lines.length; i++) {
      if (posMatchedIndices.has(i) || singleLetterHeaders.test(lines[i])) continue;
      const line = lines[i];
      if (hasLatin(line) && hasCJK(line)) {
        const cjkIndex = line.search(/[一-鿿㐀-䶿]/);
        if (cjkIndex > 0) {
          const english = line.substring(0, cjkIndex).trim();
          const chinese = line.substring(cjkIndex).trim();
          if (english && chinese) extraResults.push({ english, chinese });
        }
      }
    }
    return [...posResults, ...extraResults];
  }

  // 策略 4: 交替英文/中文行
  const hasCJK = (s) => /[一-鿿㐀-䶿]/.test(s);
  const hasLatin = (s) => /[a-zA-Z]/.test(s);
  const nonHeaderLines = lines.filter(l => !singleLetterHeaders.test(l));
  let altCount = 0;
  for (let i = 0; i < nonHeaderLines.length - 1; i += 2) {
    if (hasLatin(nonHeaderLines[i]) && !hasCJK(nonHeaderLines[i]) &&
        hasCJK(nonHeaderLines[i + 1]) && !hasLatin(nonHeaderLines[i + 1])) {
      altCount++;
    }
  }
  if (altCount > nonHeaderLines.length * 0.2) {
    const results = [];
    for (let i = 0; i < nonHeaderLines.length - 1; i += 2) {
      if (hasLatin(nonHeaderLines[i]) && hasCJK(nonHeaderLines[i + 1])) {
        results.push({ english: nonHeaderLines[i].trim(), chinese: nonHeaderLines[i + 1].trim() });
      }
    }
    return results;
  }

  // 策略 5: 单行中包含英文和中文（空格分隔）
  const mixedResults = [];
  for (const line of lines) {
    if (singleLetterHeaders.test(line)) continue;
    if (hasLatin(line) && hasCJK(line)) {
      // 找到中文开始的位置
      const cjkIndex = line.search(/[一-鿿㐀-䶿]/);
      if (cjkIndex > 0) {
        const english = line.substring(0, cjkIndex).trim();
        const chinese = line.substring(cjkIndex).trim();
        if (english && chinese) mixedResults.push({ english, chinese });
      }
    }
  }
  if (mixedResults.length > lines.length * 0.3) {
    return mixedResults;
  }

  return []; // 所有策略都失败
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

          // DOCX/DOC 文件：mammoth 提取 + 多策略解析
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

              // 策略 1-5: 本地确定性解析
              const localResults = localParseWords(rawText);
              if (localResults.length > 50) {
                // 本地解析成功（匹配 >50 个词），直接返回
                console.log(`Local parsing extracted ${localResults.length} words, skipping AI`);
                const output = localResults.map(p => `${p.english}#${p.chinese}`).join('\n');
                res.json({ success: true, data: output });
                break;
              }

              // 本地解析不足，回退到 DeepSeek 分块处理
              console.log(`Local parsing found only ${localResults.length} words, using DeepSeek`);

              const CHUNK_SIZE = 8000;
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

              console.log(`Processing ${chunks.length} chunks via DeepSeek`);

              const allPairs = new Map();
              // 保留本地解析结果
              for (const p of localResults) {
                allPairs.set(p.english.toLowerCase(), p);
              }

              const BATCH_SIZE = 8;
              for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
                const batch = chunks.slice(i, i + BATCH_SIZE);
                const results = await Promise.all(batch.map(async (chunk) => {
                  const messages = [{
                    role: "user",
                    content: `Extract English-Chinese word pairs from this text. Output one pair per line as "English#Chinese". Skip headers, instructions, and non-vocabulary content. Skip purely Chinese or purely English lines. If you see alternating English/Chinese lines, pair them up. Output ONLY the word pairs.\n\nText:\n${chunk}`
                  }];
                  try {
                    const response = await callDeepSeekAPI(messages);
                    return response.split('\n').filter(l => l.trim() && l.includes('#'));
                  } catch (err) {
                    console.error(`Chunk processing failed:`, err.message);
                    return [];
                  }
                }));
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
            res.json({ success: true, data: { libraryName: "我的单词库", subsetNames: ["默认"] } });
            break;
          }
          // 只取前 3000 字符给 AI 分析结构（不需要全部文字）
          const sample = text.length > 3000 ? text.substring(0, 3000) + "\n..." : text;
          // 估算总行数
          const totalLines = text.split('\n').filter(l => l.trim()).length;
          const messages = [
            {
              role: "user",
              content: `分析以下英语单词学习材料的结构。

这个文件共有约 ${totalLines} 行。

请完成以下任务：
1. 识别这是什么类型的词汇表（如：教材单元、考试词汇、按字母排列等）
2. 建议一个合适的单词库名称
3. 根据内容结构建议子集划分（如按字母 A-Z、按单元、按主题等）
4. 如果无法识别明显的分组结构，就作为一个子集

回复严格的 JSON 格式（不要包含单词本身，只需要结构信息）：
{
  "libraryName": "建议的单词库名称",
  "description": "简要描述这是什么词汇表",
  "subsets": [
    { "name": "子集名称1", "description": "包含什么内容" },
    { "name": "子集名称2", "description": "包含什么内容" }
  ]
}

文件内容（前部分样本）：
${sample}`
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

        // 8. 生成句子填空题目 (DeepSeek)
        case "generateSentences": {
          const { words: wordList } = data;
          if (!Array.isArray(wordList) || wordList.length === 0) {
            res.json({ success: true, data: [] });
            break;
          }
          const messages = [{
            role: "user",
            content: `For each English word below, generate a fill-in-the-blank sentence where the target word is replaced by a blank (_______). Also provide 3 distractor words that are plausible but incorrect.

Words: ${JSON.stringify(wordList.map(w => ({ english: w.english, chinese: w.chinese })))}

Reply ONLY with a JSON array, no other text:
[{
  "word": "beautiful",
  "chinese": "美丽的",
  "sentence": "She has a _______ smile.",
  "distractors": ["handsome", "lovely", "pretty"]
}]`
          }];
          const response = await callDeepSeekAPI(messages);
          const parsed = parseGeminiJson(response);
          res.json({ success: true, data: Array.isArray(parsed) ? parsed : [] });
          break;
        }

        // 8. DeepSeek 生成 MCQ 干扰项（Gemini 降级方案）
        case "mcqOptionsDeepSeek": {
          const { wordList, allQuizWords } = data;
          if (!Array.isArray(wordList) || wordList.length === 0) {
            res.json({ success: true, data: [] });
            break;
          }
          const messages = [{
            role: "user",
            content: `For each English word below, generate 3 incorrect Chinese translation options (distractors) for a multiple choice quiz.

Rules:
1. One distractor should be a plausible wrong answer (similar meaning, commonly confused word)
2. Two distractors should be clearly wrong but tempting for a student
3. All distractors must be real Chinese words/phrases
4. None should be the correct translation
5. Do NOT use any of these words as distractors: ${JSON.stringify(allQuizWords)}

Words: ${JSON.stringify(wordList.map(w => ({ english: w.english, chinese: w.chinese })))}

Reply ONLY with a JSON array, no other text:
[{"word": "abandon", "distractors": ["抛弃", "实现", "接受"]}]`
          }];
          const deepseekResult = await callDeepSeekAPI(messages);
          const parsed = parseGeminiJson(deepseekResult);
          res.json({ success: true, data: Array.isArray(parsed) ? parsed : [] });
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
