// ================= ÇEVİRİ VE AI YARDIMCISI MODÜLÜ (js/translate.js) =================

const translateService = {
    // Helper to perform CapacitorHttp native requests (to bypass CORS on mobile) or standard fetch on web
    async makeHttpRequest(url, method, headers, bodyObj) {
        if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) {
            try {
                console.log("Using CapacitorHttp native request");
                const response = await window.Capacitor.Plugins.CapacitorHttp.request({
                    url: url,
                    method: method,
                    headers: headers,
                    data: bodyObj
                });
                return {
                    ok: response.status >= 200 && response.status < 300,
                    status: response.status,
                    json: async () => typeof response.data === 'string' ? JSON.parse(response.data) : response.data
                };
            } catch (err) {
                console.warn("CapacitorHttp failed, falling back to fetch", err);
            }
        }
        
        const response = await fetch(url, {
            method: method,
            headers: headers,
            body: JSON.stringify(bodyObj)
        });
        return response;
    },

    postProcessTranslation(text) {
        if (!text || typeof text !== 'string') return text;
        // Fix common AI/Google translation typos: barier -> bariyer
        return text.replace(/barier/gi, match => match.startsWith('B') ? 'Bariyer' : 'bariyer');
    },

    // 1. Ücretsiz Google Translate Entegrasyonu (API Key Gerektirmez)
    async translateGoogle(text, targetLang = 'tr') {
        if (!text || !text.trim()) return "";
        try {
            const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text.trim())}&cb=${Date.now()}`;
            const response = await fetch(url, { cache: "no-cache" });
            if (!response.ok) throw new Error("Çeviri servisi yanıt vermedi.");
            
            const data = await response.json();
            
            // Google Translate yanıt formatı: data[0] içindeki dizilerin ilk elemanları çeviri parçalarıdır
            if (data && data[0]) {
                const translatedText = data[0].map(item => item[0]).join('');
                return this.postProcessTranslation(translatedText);
            }
            throw new Error("Geçersiz çeviri verisi.");
        } catch (err) {
            console.error("Google Çeviri Hatası:", err);
            return "Çeviri yapılamadı. İnternet bağlantınızı kontrol edin.";
        }
    },
 
    async translateGoogleWithDetails(text, targetLang = 'tr', sourceLang = 'auto') {
        if (!text || !text.trim()) return { text: "", lang: "" };
        try {
            const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&q=${encodeURIComponent(text.trim())}&cb=${Date.now()}`;
            const response = await fetch(url, { cache: "no-cache" });
            if (!response.ok) throw new Error("Çeviri servisi yanıt vermedi.");
            
            const data = await response.json();
            if (data && data[0]) {
                const translatedText = data[0].map(item => item[0]).join('');
                const detectedLang = data[2] || "";
                return { text: this.postProcessTranslation(translatedText), lang: detectedLang };
            }
            throw new Error("Geçersiz çeviri verisi.");
        } catch (err) {
            console.error("Google Çeviri Hatası:", err);
            return { text: text, lang: "" };
        }
    },

    // 2. Gemini API Entegrasyonu (Bağlamsal AI Analizi)
    async explainWithGemini(text, contextSentence, apiKey) {
        if (!apiKey) throw new Error("Gemini API Anahtarı bulunamadı. Ayarlar kısmından ekleyin.");
        
        const models = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-2.5-pro", "gemini-1.5-flash", "gemini-1.5-pro"];
        let lastError = null;

        const prompt = `Sen yardımcı bir yabancı dil öğretmenisin. Bir kitap okuyucusu aşağıdaki kelimeyi veya cümleyi seçti. 
Seçilen Metin: "${text}"
Bulunduğu Cümle/Bağlam: "${contextSentence || "Belirtilmedi"}"

Lütfen bu kelimeyi veya cümleyi Türkçe'ye çevir. Kitap bağlamını dikkate alarak anlamını açıkla, varsa deyimsel/mecazi kullanımları ve kelime kökeni hakkında kısa, çarpıcı bilgiler ver.
Yanıtını mobil ekrana uygun, kısa ve net (maksimum 4-5 kısa satır) olacak şekilde şık bir dille yaz. HTML etiketleri kullanma, düzgün boşluklar ve emoji kullanabilirsin.`;

        const requestBody = {
            contents: [{
                parts: [{ text: prompt }]
            }]
        };

        for (const model of models) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${apiKey}`;
                const response = await this.makeHttpRequest(url, 'POST', { 'Content-Type': 'application/json' }, requestBody);

                if (response.ok) {
                    const data = await response.json();
                    if (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0]) {
                        return this.postProcessTranslation(data.candidates[0].content.parts[0].text);
                    }
                } else {
                    const errorData = await response.json();
                    lastError = new Error(errorData.error?.message || `API returned status ${response.status}`);
                }
            } catch (err) {
                lastError = err;
            }
        }

        console.error("Gemini API Hatası:", lastError);
        return `AI Açıklaması alınamadı: ${lastError ? lastError.message : "Bilinmeyen Hata"}`;
    },

    // 2.2. Gemini ile Toplu Paragraf Çevirisi (Usta Çevirmen)
    async translateBatchWithGemini(texts, targetLang = 'Turkish', apiKey) {
        if (!apiKey) throw new Error("Gemini API Anahtarı bulunamadı. Ayarlar kısmından ekleyin.");
        if (!texts || texts.length === 0) return [];

        const models = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-2.5-pro", "gemini-1.5-flash", "gemini-1.5-pro"];
        let lastError = null;

        const systemPrompt = `You are an exceptionally professional, experienced, and master translator. Your task is to translate the provided array of text paragraphs into the target language in the most natural, fluent, and culturally appropriate way.

Rules:
1. Preserve the tone, emotion, register (formal, informal, poetic, technical, etc.), and nuance of each paragraph.
2. Avoid literal (word-for-word) translation. Instead, use the most idiomatic expression in the target language.
3. Adapt idioms, proverbs, and cultural references to their closest equivalents.
4. Strictly follow the grammar, spelling, and punctuation rules of the target language.
5. Return the result in the exact same array length and order.
6. You MUST return your response as a valid JSON array of strings:
[
  "Translated paragraph 1",
  "Translated paragraph 2",
  ...
]`;

        const userPrompt = `Target Language: ${targetLang}

Input Paragraphs Array:
${JSON.stringify(texts, null, 2)}

Strict Rule: You must return your response as a valid JSON array of strings matching the length and order of the input. Do NOT add any extra markdown formatting, backticks, or intro/outro text.`;

        const combinedPrompt = `${systemPrompt}\n\n${userPrompt}`;

        const requestBody = {
            contents: [{
                parts: [{ text: combinedPrompt }]
            }]
        };

        const errors = [];
        for (const model of models) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${apiKey}`;
                const response = await this.makeHttpRequest(url, 'POST', { 'Content-Type': 'application/json' }, requestBody);

                if (response.ok) {
                    const data = await response.json();
                    if (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0]) {
                        const rawText = data.candidates[0].content.parts[0].text;
                        let cleanText = rawText.trim();
                        if (cleanText.startsWith("```")) {
                            cleanText = cleanText.replace(/^```(?:json)?\s*/i, "");
                            cleanText = cleanText.replace(/\s*```$/, "");
                        }
                        try {
                            const parsedArray = JSON.parse(cleanText.trim());
                            if (Array.isArray(parsedArray)) {
                                return parsedArray.map(t => this.postProcessTranslation(t));
                            }
                            throw new Error("API array yerine başka bir JSON formatı döndü.");
                        } catch (parseErr) {
                            console.warn("Gemini batch JSON parse failed, rawText was:", rawText, parseErr);
                            throw new Error("JSON parse hatası: " + parseErr.message + " (Gelen: " + rawText.slice(0, 80) + ")");
                        }
                    } else {
                        throw new Error("Geçersiz API yanıt yapısı (candidates/parts eksik).");
                    }
                } else {
                    let errMsg = `Status ${response.status}`;
                    try {
                        const errorData = await response.json();
                        if (errorData && errorData.error && errorData.error.message) {
                            errMsg = errorData.error.message;
                        }
                    } catch (e) {}
                    throw new Error(errMsg);
                }
            } catch (err) {
                errors.push(`${model}: ${err.message}`);
            }
        }

        console.error("Gemini Batch API Hataları:", errors);
        throw new Error(errors.join("\n"));
    },

    // 2.3. OpenAI ile Toplu Paragraf Çevirisi (Usta Çevirmen)
    async translateBatchWithOpenAI(texts, targetLang = 'Turkish', apiKey) {
        if (!apiKey) throw new Error("OpenAI API Anahtarı bulunamadı. Ayarlar kısmından ekleyin.");
        if (!texts || texts.length === 0) return [];

        const url = "https://api.openai.com/v1/chat/completions";
        const systemPrompt = `ROLE: Sen, Asya web romanları (Wuxia, Xianxia, Light Novel vb.) ve İngilizce edebi eserlerin Türkçe çevirisinde uzmanlaşmış, son derece deneyimli ve usta bir edebiyat çevirmeni ve editörsün. Görevin, verilen İngilizce web romanı paragraflarını en doğal, akıcı ve edebi Türkçe roman diliyle çevirmektir.

Kurallar:
1. Asla kelimesi kelimesine robotik çeviri yapma. Türkçe'nin doğal söz dizimini, deyimlerini ve samimi diyalog yapılarını kullan.
2. Roman anlatım tarzını koru. Geçmiş zaman yapılarını (-di/-miş) akıcı bir şekilde aktar.
3. Detayları kırpma, özetleme veya olay ekleme. Orijinal anlamı ve tüm betimlemeleri birebir koru.
4. "No, not a boar. Dozens of them." ifadesini bağlamsal olarak ("Hayır, sadece bir yaban domuzu değil. Onlarcası birden geliyor!") şeklinde çevir.
5. Yanıtı kesinlikle sadece şu JSON formatında, "translations" anahtarı içeren bir dizi olarak döndür:
{
  "translations": [
    "Çevrilmiş paragraf 1",
    "Çevrilmiş paragraf 2",
    ...
  ]
}`;

        const userPrompt = `Target Language: ${targetLang}

Input Paragraphs Array:
${JSON.stringify(texts, null, 2)}`;

        const requestBody = {
            model: "gpt-4o-mini",
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            temperature: 0.65
        };

        try {
            const response = await this.makeHttpRequest(url, 'POST', {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            }, requestBody);

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error?.message || `API returned status ${response.status}`);
            }

            const data = await response.json();
            if (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) {
                const cleanText = data.choices[0].message.content.trim();
                const parsed = JSON.parse(cleanText);
                if (parsed && Array.isArray(parsed.translations)) {
                    return parsed.translations.map(t => this.postProcessTranslation(t));
                }
                throw new Error("API translations dizisi içeren bir JSON döndürmedi.");
            }
            throw new Error("Geçersiz OpenAI API yanıt yapısı.");
        } catch (err) {
            console.error("OpenAI Batch API Hatası:", err);
            throw err;
        }
    },

    // 3. OpenAI API Entegrasyonu (Bağlamsal AI Analizi)
    async explainWithOpenAI(text, contextSentence, apiKey) {
        if (!apiKey) throw new Error("OpenAI API Anahtarı bulunamadı. Ayarlar kısmından ekleyin.");

        const url = "https://api.openai.com/v1/chat/completions";
        const prompt = `Seçilen Metin: "${text}"
Bulunduğu Cümle: "${contextSentence || "Belirtilmedi"}"`;

        const requestBody = {
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "Sen bir kitap okuma asistanı ve dil uzmanısın. Sana verilen yabancı dildeki kelime veya cümleleri Türkçe'ye çevirir, romandaki bağlama uygun olarak açıklar, varsa deyimsel anlamını belirtirsin. Mobil ekran için maksimum 4-5 kısa satırlık, temiz ve anlaşılır yanıtlar üret."
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            max_tokens: 200,
            temperature: 0.7
        };

        try {
            const response = await this.makeHttpRequest(url, 'POST', {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            }, requestBody);

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error?.message || "OpenAI API hatası.");
            }

            const data = await response.json();
            return this.postProcessTranslation(data.choices[0].message.content.trim());
        } catch (err) {
            console.error("OpenAI API Hatası:", err);
            return `AI Açıklaması alınamadı: ${err.message}`;
        }
    },

    // 4. Tarayıcı Tabanlı Seslendirme (TTS - Text to Speech)
    speak(text, lang = '') {
        if (!('speechSynthesis' in window)) {
            console.warn("Speech Synthesis tarayıcınız tarafından desteklenmiyor.");
            return;
        }
        
        try {
            window.speechSynthesis.cancel();
        } catch (e) {
            console.warn("SpeechSynthesis cancel failed:", e);
        }

        try {
            const utterance = new SpeechSynthesisUtterance(text);
            
            // Try to use the selected voice from reader settings if available
            const voiceSelect = document.getElementById('tts-voice-select');
            let voiceSet = false;
            const voices = window.speechSynthesis.getVoices();

            if (voiceSelect && voiceSelect.value !== 'default') {
                const selectedVoiceName = voiceSelect.value;
                const matchedVoice = voices.find(v => v.name === selectedVoiceName);
                if (matchedVoice) {
                    utterance.voice = matchedVoice;
                    utterance.lang = matchedVoice.lang;
                    voiceSet = true;
                }
            }

            if (!voiceSet) {
                let targetLang = "";
                if (lang) {
                    targetLang = lang.split('-')[0].toLowerCase();
                    utterance.lang = lang;
                } else {
                    const hasTurkishChars = /[çğıöşüÇĞİÖŞÜ]/.test(text);
                    targetLang = hasTurkishChars ? 'tr' : 'en';
                    utterance.lang = hasTurkishChars ? 'tr-TR' : 'en-US';
                }
                
                const matchingVoice = voices.find(v => {
                    const l = v.lang.toLowerCase();
                    return l.startsWith(targetLang);
                });
                if (matchingVoice) {
                    utterance.voice = matchingVoice;
                }
            }

            // Hız ayarı (0.9 mobil okumalarda idealdir)
            utterance.rate = 0.95;
            
            window.speechSynthesis.speak(utterance);
        } catch (speechErr) {
            console.error("Failed to speak translation popover:", speechErr);
        }
    }
};
