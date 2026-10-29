// ================= ÇEVİRİ VE SESLENDİRME MODÜLÜ (js/translate.js) =================

const translateService = {
    postProcessTranslation(text) {
        if (!text || typeof text !== 'string') return text;
        // Fix common Google translation typos: barier -> bariyer
        return text.replace(/barier/gi, match => match.startsWith('B') ? 'Bariyer' : 'bariyer');
    },

    // Damerau-Levenshtein Mesafesi (Yan yana harf yer değiştirmelerini - örn. Brusier <-> Bruiser - 1 adım sayar)
    damerauLevenshtein(a, b) {
        const s1 = (a || '').toLowerCase();
        const s2 = (b || '').toLowerCase();
        const len1 = s1.length;
        const len2 = s2.length;
        if (len1 === 0) return len2;
        if (len2 === 0) return len1;

        const dp = Array.from({ length: len1 + 1 }, () => new Array(len2 + 1).fill(0));
        for (let i = 0; i <= len1; i++) dp[i][0] = i;
        for (let j = 0; j <= len2; j++) dp[0][j] = j;

        for (let i = 1; i <= len1; i++) {
            for (let j = 1; j <= len2; j++) {
                const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
                dp[i][j] = Math.min(
                    dp[i - 1][j] + 1,       // silme
                    dp[i][j - 1] + 1,       // ekleme
                    dp[i - 1][j - 1] + cost // değiştirme
                );
                if (i > 1 && j > 1 && s1[i - 1] === s2[j - 2] && s1[i - 2] === s2[j - 1]) {
                    dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1); // yan yana harf takası (transposition)
                }
            }
        }
        return dp[len1][len2];
    },

    // 1. Ücretsiz Google Translate Entegrasyonu
    async translateGoogle(text, targetLang = 'tr', sourceLang = 'auto') {
        if (!text || !text.trim()) return "";
        try {
            const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&q=${encodeURIComponent(text.trim())}&cb=${Date.now()}`;
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
        if (!text || !text.trim()) return { text: "", lang: "", dictTerms: [], altTerms: [], correctedQuery: "" };
        try {
            const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&dt=bd&dt=at&dt=qc&dt=rw&q=${encodeURIComponent(text.trim())}&cb=${Date.now()}`;
            const response = await fetch(url, { cache: "no-cache" });
            if (!response.ok) throw new Error("Çeviri servisi yanıt vermedi.");
            
            const data = await response.json();
            if (data && data[0]) {
                const translatedText = data[0].map(item => item[0]).join('');
                const detectedLang = data[2] || "";

                // Sözlük eş anlamlıları (dt=bd -> data[1])
                const dictTerms = [];
                if (Array.isArray(data[1])) {
                    data[1].forEach(posGroup => {
                        if (Array.isArray(posGroup) && Array.isArray(posGroup[1])) {
                            posGroup[1].forEach(term => {
                                if (typeof term === 'string' && term.trim()) {
                                    dictTerms.push(term.trim());
                                }
                            });
                        }
                    });
                }

                // Alternatif çeviriler (dt=at -> data[5])
                const altTerms = [];
                if (Array.isArray(data[5])) {
                    data[5].forEach(seg => {
                        if (Array.isArray(seg) && Array.isArray(seg[2])) {
                            seg[2].forEach(alt => {
                                if (Array.isArray(alt) && typeof alt[0] === 'string' && alt[0].trim()) {
                                    altTerms.push(alt[0].trim());
                                }
                            });
                        }
                    });
                }

                // Yazım düzeltme önerisi (dt=qc -> data[7], örn. "Brusier" -> "bruiser")
                let correctedQuery = "";
                if (Array.isArray(data[7]) && typeof data[7][1] === 'string' && data[7][1].trim()) {
                    correctedQuery = data[7][1].trim();
                } else if (Array.isArray(data[7]) && typeof data[7][0] === 'string' && data[7][0].trim()) {
                    correctedQuery = data[7][0].replace(/<[^>]+>/g, '').trim();
                }

                return {
                    text: this.postProcessTranslation(translatedText),
                    lang: detectedLang,
                    dictTerms,
                    altTerms,
                    correctedQuery
                };
            }
            throw new Error("Geçersiz çeviri verisi.");
        } catch (err) {
            console.error("Google Çeviri Hatası:", err);
            return { text: text, lang: "", dictTerms: [], altTerms: [], correctedQuery: "" };
        }
    },

    // Tek kelime veya ifadeyi (yazım hatası / büyük harf özel isim algısı / bağlam farkı olsa bile) doğru Türkçeye çevirir
    async translateSmartToTurkish(rawText, contextSentence = "", sourceLangHint = "auto", preferredTrHint = "") {
        const clean = (rawText || "").replace(/\s+/g, " ").trim();
        if (!clean) return "";

        const norm = (s) => (s || "")
            .trim()
            .toLowerCase()
            .replace(/^[^a-zA-Z0-9À-ÿçğıöşüÇĞİÖŞÜ]+|[^a-zA-Z0-9À-ÿçğıöşüÇĞİÖŞÜ]+$/g, "");

        const isUntranslated = (tr, orig) => {
            const nTr = norm(tr);
            const nOrig = norm(orig);
            return !nTr || nTr === nOrig;
        };

        const srcLang = (sourceLangHint && sourceLangHint !== 'auto') ? sourceLangHint : 'auto';

        // 1. İlk zengin çeviri sorgusu
        const firstRes = await this.translateGoogleWithDetails(clean, 'tr', srcLang);
        let bestTr = (firstRes && firstRes.text) ? firstRes.text.trim() : "";

        // Eğer sayfa zaten Türkçeye çevrilmişse ve seçilen Türkçe kelime (preferredTrHint) sözlük/alternatif listesinde varsa onu tercih et
        if (preferredTrHint && norm(preferredTrHint) !== norm(clean)) {
            const nPref = norm(preferredTrHint);
            const allCands = [bestTr, ...(firstRes.dictTerms || []), ...(firstRes.altTerms || [])].map(norm);
            if (allCands.some(c => c && (c === nPref || c.includes(nPref) || nPref.includes(c)))) {
                return preferredTrHint.trim();
            }
        }

        // 2. Eğer Google yazım düzeltmesi (correctedQuery, örn. Brusier -> bruiser) döndürdüyse onu çevir
        if (isUntranslated(bestTr, clean) && firstRes.correctedQuery && norm(firstRes.correctedQuery) !== norm(clean)) {
            const corrRes = await this.translateGoogleWithDetails(firstRes.correctedQuery.toLowerCase(), 'tr', srcLang === 'auto' ? 'en' : srcLang);
            if (corrRes && !isUntranslated(corrRes.text, firstRes.correctedQuery)) {
                bestTr = corrRes.text.trim();
            } else if (corrRes && corrRes.dictTerms && corrRes.dictTerms.length > 0) {
                bestTr = corrRes.dictTerms[0];
            }
        }

        // 3. Eğer hâlâ çevrilmediyse ve kelimede büyük harf varsa (Google büyük harfli tek kelimeleri özel isim sanıp çevirmeyebilir):
        // Küçük harfe çevirip tekrar dene
        const cleanWords = clean.split(/\s+/).filter(Boolean);
        if (isUntranslated(bestTr, clean) && clean !== clean.toLowerCase()) {
            const lowerRes = await this.translateGoogleWithDetails(clean.toLowerCase(), 'tr', srcLang === 'auto' ? 'en' : srcLang);
            if (lowerRes) {
                if (!isUntranslated(lowerRes.text, clean)) {
                    bestTr = lowerRes.text.trim();
                } else if (lowerRes.dictTerms && lowerRes.dictTerms.length > 0 && !isUntranslated(lowerRes.dictTerms[0], clean)) {
                    bestTr = lowerRes.dictTerms[0];
                } else if (lowerRes.correctedQuery && norm(lowerRes.correctedQuery) !== norm(clean)) {
                    const corrRes2 = await this.translateGoogleWithDetails(lowerRes.correctedQuery.toLowerCase(), 'tr', 'en');
                    if (corrRes2 && !isUntranslated(corrRes2.text, lowerRes.correctedQuery)) {
                        bestTr = corrRes2.text.trim();
                    }
                }
            }
        }

        // 4. Tek bir İngilizce kelime hâlâ aynı dönüyorsa ("Brusier" gibi):
        // a) Başa "a " ekleyerek ("a brusier") Google'ın isim/sıfat bağlamını ve cümle içi yazım denetimini tetikle
        if (isUntranslated(bestTr, clean) && cleanWords.length === 1) {
            const singleWord = norm(clean);
            if (singleWord.length >= 3 && /^[a-z]+$/i.test(singleWord)) {
                const phraseQuery = `a ${singleWord.toLowerCase()}`;
                const phraseRes = await this.translateGoogleWithDetails(phraseQuery, 'tr', 'en');
                if (phraseRes) {
                    if (phraseRes.correctedQuery) {
                        const corrWord = phraseRes.correctedQuery.replace(/^an?\s+/i, '').trim();
                        if (corrWord && norm(corrWord) !== singleWord) {
                            const cwRes = await this.translateGoogleWithDetails(corrWord.toLowerCase(), 'tr', 'en');
                            if (cwRes && !isUntranslated(cwRes.text, corrWord)) {
                                bestTr = cwRes.text.trim();
                            } else if (cwRes && cwRes.dictTerms && cwRes.dictTerms.length > 0) {
                                bestTr = cwRes.dictTerms[0];
                            }
                        }
                    }
                    if (isUntranslated(bestTr, clean) && phraseRes.text) {
                        const strippedTr = phraseRes.text.replace(/^bir\s+/i, '').trim();
                        if (strippedTr && !isUntranslated(strippedTr, singleWord)) {
                            bestTr = strippedTr;
                        }
                    }
                }

                // b) Yan yana harf yer değiştirmesi (transposition) kontrolü (örn. "brusier" -> "bruiser" -> "kabadayı")
                if (isUntranslated(bestTr, clean) && singleWord.length >= 4 && singleWord.length <= 14) {
                    const transpositions = [];
                    for (let i = 1; i < singleWord.length - 1; i++) {
                        if (singleWord[i] !== singleWord[i + 1]) {
                            const swapped = singleWord.slice(0, i) + singleWord[i + 1] + singleWord[i] + singleWord.slice(i + 2);
                            if (!transpositions.includes(swapped)) {
                                transpositions.push(swapped);
                            }
                        }
                    }
                    if (singleWord.length >= 5 && singleWord[0] !== singleWord[1]) {
                        const swapped0 = singleWord[1] + singleWord[0] + singleWord.slice(2);
                        if (!transpositions.includes(swapped0)) transpositions.push(swapped0);
                    }

                    if (transpositions.length > 0) {
                        const batchStr = transpositions.join('\n');
                        const batchTr = await this.translateGoogle(batchStr, 'tr', 'en');
                        const trLines = (batchTr || '').split('\n').map(l => l.trim());

                        for (let k = 0; k < transpositions.length; k++) {
                            const candEn = transpositions[k];
                            const candTr = trLines[k] || '';
                            if (candTr && !isUntranslated(candTr, candEn) && !isUntranslated(candTr, singleWord)) {
                                const verifyRes = await this.translateGoogleWithDetails(candEn, 'tr', 'en');
                                if (verifyRes && (
                                    (verifyRes.dictTerms && verifyRes.dictTerms.length > 0) ||
                                    !isUntranslated(verifyRes.text, candEn)
                                )) {
                                    if (preferredTrHint && verifyRes.dictTerms) {
                                        const matchPref = verifyRes.dictTerms.find(dt => norm(dt) === norm(preferredTrHint));
                                        if (matchPref) {
                                            bestTr = matchPref;
                                            break;
                                        }
                                    }
                                    bestTr = (verifyRes.text && !isUntranslated(verifyRes.text, candEn))
                                        ? verifyRes.text.trim()
                                        : verifyRes.dictTerms[0];
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }

        // 5. Hâlâ çevrilmediyse ve sayfa zaten Türkçeye çevrilmişse (preferredTrHint mevcutsa), ekrandaki Türkçe karşılığı kullan
        if (isUntranslated(bestTr, clean) && preferredTrHint && !isUntranslated(preferredTrHint, clean)) {
            bestTr = preferredTrHint.trim();
        }

        return bestTr || clean;
    },

    // 2. Tarayıcı Tabanlı Seslendirme (TTS - Text to Speech)
    speak(text, lang = '') {
        if (!('speechSynthesis' in window)) {
            console.warn("Speech Synthesis tarayıcınız tarafından desteklenmiyor.");
            return;
        }
        if (!text || !text.trim()) return;

        try {
            window.speechSynthesis.cancel();
        } catch (e) {
            console.warn("SpeechSynthesis cancel failed:", e);
        }

        setTimeout(() => {
            try {
                if (window.speechSynthesis.paused) {
                    window.speechSynthesis.resume();
                }

                const utterance = new SpeechSynthesisUtterance(text.trim());
                
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

                const speedSelect = document.getElementById('tts-speed-select');
                const speed = speedSelect ? parseFloat(speedSelect.value) : 0.95;
                utterance.rate = speed || 0.95;
                
                window.speechSynthesis.speak(utterance);
            } catch (speechErr) {
                console.error("Failed to speak translation popover:", speechErr);
            }
        }, 50);
    }
};
