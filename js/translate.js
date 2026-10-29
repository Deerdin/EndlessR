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
        if (!text || !text.trim()) {
            return {
                text: "",
                lang: "",
                dictTerms: [],
                dictEntries: [],
                altTerms: [],
                correctedQuery: "",
                synsets: [],
                definitions: [],
                posLabel: ""
            };
        }
        try {
            const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&dt=bd&dt=at&dt=md&dt=ss&dt=qc&dt=rw&q=${encodeURIComponent(text.trim())}&cb=${Date.now()}`;
            const response = await fetch(url, { cache: "no-cache" });
            if (!response.ok) throw new Error("Çeviri servisi yanıt vermedi.");
            
            const data = await response.json();
            if (data && data[0]) {
                const translatedText = data[0].map(item => item[0]).join('');
                const detectedLang = data[2] || "";

                const posMapTr = {
                    noun: "İsim",
                    verb: "Fiil",
                    adjective: "Sıfat",
                    adverb: "Zarf",
                    pronoun: "Zamir",
                    preposition: "Edat",
                    conjunction: "Bağlaç",
                    interjection: "Ünlem",
                    exclamation: "Ünlem"
                };

                // Sözlük eş anlamlıları ve detaylı girişler (dt=bd -> data[1])
                const dictTerms = [];
                const dictEntries = [];
                let primaryPos = "";
                if (Array.isArray(data[1])) {
                    data[1].forEach(posGroup => {
                        if (Array.isArray(posGroup)) {
                            const posRaw = (typeof posGroup[0] === 'string') ? posGroup[0].toLowerCase() : "";
                            if (!primaryPos && posRaw) {
                                primaryPos = posMapTr[posRaw] || posGroup[0];
                            }
                            const baseForm = (typeof posGroup[3] === 'string') ? posGroup[3].trim() : "";
                            if (Array.isArray(posGroup[1])) {
                                posGroup[1].forEach(term => {
                                    if (typeof term === 'string' && term.trim()) {
                                        dictTerms.push(this.postProcessTranslation(term.trim()));
                                    }
                                });
                            }
                            if (Array.isArray(posGroup[2])) {
                                posGroup[2].forEach(entry => {
                                    if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[0].trim()) {
                                        dictEntries.push({
                                            word: this.postProcessTranslation(entry[0].trim()),
                                            reverse: Array.isArray(entry[1]) ? entry[1].map(r => String(r).toLowerCase().trim()) : [],
                                            score: typeof entry[3] === 'number' ? entry[3] : 0,
                                            pos: posRaw,
                                            posTr: posMapTr[posRaw] || posRaw,
                                            baseForm
                                        });
                                    }
                                });
                            }
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
                                    altTerms.push(this.postProcessTranslation(alt[0].trim()));
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

                // Eş anlamlı kümeleri (dt=ss -> data[11])
                const synsets = [];
                if (Array.isArray(data[11])) {
                    data[11].forEach(synGroup => {
                        if (Array.isArray(synGroup) && Array.isArray(synGroup[1])) {
                            const posRaw = (typeof synGroup[0] === 'string') ? synGroup[0].toLowerCase() : "";
                            synGroup[1].forEach(se => {
                                if (Array.isArray(se) && Array.isArray(se[0])) {
                                    synsets.push({
                                        pos: posRaw,
                                        synonyms: se[0].map(s => String(s).toLowerCase().trim()),
                                        definitionId: typeof se[1] === 'string' ? se[1] : ""
                                    });
                                }
                            });
                        }
                    });
                }

                // Sözlük tanımları (dt=md -> data[12])
                const definitions = [];
                if (Array.isArray(data[12])) {
                    data[12].forEach(defGroup => {
                        if (Array.isArray(defGroup) && Array.isArray(defGroup[1])) {
                            const posRaw = (typeof defGroup[0] === 'string') ? defGroup[0].toLowerCase() : "";
                            if (!primaryPos && posRaw) {
                                primaryPos = posMapTr[posRaw] || defGroup[0];
                            }
                            defGroup[1].forEach(de => {
                                if (Array.isArray(de) && typeof de[0] === 'string' && de[0].trim()) {
                                    definitions.push({
                                        pos: posRaw,
                                        posTr: posMapTr[posRaw] || posRaw,
                                        gloss: de[0].trim(),
                                        definitionId: typeof de[1] === 'string' ? de[1] : "",
                                        example: typeof de[2] === 'string' ? de[2].trim() : ""
                                    });
                                }
                            });
                        }
                    });
                }

                return {
                    text: this.postProcessTranslation(translatedText),
                    lang: detectedLang,
                    dictTerms,
                    dictEntries,
                    altTerms,
                    correctedQuery,
                    synsets,
                    definitions,
                    posLabel: primaryPos
                };
            }
            throw new Error("Geçersiz çeviri verisi.");
        } catch (err) {
            console.error("Google Çeviri Hatası:", err);
            return {
                text: text,
                lang: "",
                dictTerms: [],
                dictEntries: [],
                altTerms: [],
                correctedQuery: "",
                synsets: [],
                definitions: [],
                posLabel: ""
            };
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

    // Google'ın dt=md alanı boş döndüğünde (örn. "bruiser") ücretsiz sözlük API'sinden İngilizce tanımları çeker
    async fetchExternalEnglishDefinitions(word) {
        const cleanWord = (word || "").trim().toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, "");
        if (!cleanWord || cleanWord.length < 2) return [];

        const posMapTr = {
            noun: "İsim",
            verb: "Fiil",
            adjective: "Sıfat",
            adverb: "Zarf",
            pronoun: "Zamir",
            preposition: "Edat",
            conjunction: "Bağlaç",
            interjection: "Ünlem"
        };

        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 1600);
            const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(cleanWord)}`, {
                signal: controller.signal
            });
            clearTimeout(timer);
            if (!res.ok) return [];
            const data = await res.json();
            const defs = [];
            if (Array.isArray(data)) {
                data.forEach(entry => {
                    if (entry && Array.isArray(entry.meanings)) {
                        entry.meanings.forEach(m => {
                            const posRaw = (m.partOfSpeech || "").toLowerCase();
                            const posTr = posMapTr[posRaw] || posRaw;
                            const mSyns = Array.isArray(m.synonyms) ? m.synonyms.map(s => String(s).toLowerCase()) : [];
                            if (Array.isArray(m.definitions)) {
                                m.definitions.forEach(d => {
                                    if (d && typeof d.definition === 'string' && d.definition.trim()) {
                                        const dSyns = Array.isArray(d.synonyms) ? d.synonyms.map(s => String(s).toLowerCase()) : [];
                                        defs.push({
                                            pos: posRaw,
                                            posTr,
                                            gloss: d.definition.trim(),
                                            example: typeof d.example === 'string' ? d.example.trim() : "",
                                            synonyms: [...mSyns, ...dSyns],
                                            definitionId: ""
                                        });
                                    }
                                });
                            }
                        });
                    }
                });
            }
            return defs;
        } catch (e) {
            return [];
        }
    },

    // Tek kelime seçildiğinde:
    // 1) Olası tüm Türkçe karşılıklarını (sözlük + alternatif anlamlar)
    // 2) Kelimenin cümlede geçen spesifik anlamını ve Türkçe açıklamasını döndürür
    async analyzeSingleWordInContext(rawText, contextSentence = "", sourceLangHint = "auto", preferredTrHint = "") {
        const clean = (rawText || "").replace(/\s+/g, " ").trim();
        if (!clean) {
            return {
                primaryTr: "",
                possibleMeanings: [],
                contextualWord: "",
                contextualExplanation: "",
                posLabel: ""
            };
        }

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
        let resolvedEnWord = clean.replace(/^[^a-zA-Z0-9À-ÿçğıöşüÇĞİÖŞÜ]+|[^a-zA-Z0-9À-ÿçğıöşüÇĞİÖŞÜ]+$/g, "") || clean;

        // 1. Kelimenin zengin sözlük verisini al (yazım hatası / büyük harf varsa düzeltilmiş kökünü de bul)
        let activeRes = await this.translateGoogleWithDetails(resolvedEnWord, 'tr', srcLang);
        let bestTr = (activeRes && activeRes.text) ? activeRes.text.trim() : "";

        const mergeDetailsInto = (target, extra) => {
            if (!extra) return;
            if (!target.posLabel && extra.posLabel) target.posLabel = extra.posLabel;
            if (Array.isArray(extra.dictTerms)) {
                extra.dictTerms.forEach(t => {
                    if (!target.dictTerms.includes(t)) target.dictTerms.push(t);
                });
            }
            if (Array.isArray(extra.dictEntries)) {
                extra.dictEntries.forEach(e => target.dictEntries.push(e));
            }
            if (Array.isArray(extra.altTerms)) {
                extra.altTerms.forEach(t => {
                    if (!target.altTerms.includes(t)) target.altTerms.push(t);
                });
            }
            if (Array.isArray(extra.synsets)) {
                extra.synsets.forEach(s => target.synsets.push(s));
            }
            if (Array.isArray(extra.definitions)) {
                extra.definitions.forEach(d => target.definitions.push(d));
            }
        };

        // Yazım düzeltmesi varsa (correctedQuery)
        if (activeRes.correctedQuery && norm(activeRes.correctedQuery) !== norm(resolvedEnWord)) {
            const corrWord = activeRes.correctedQuery.trim();
            const corrRes = await this.translateGoogleWithDetails(corrWord.toLowerCase(), 'tr', srcLang === 'auto' ? 'en' : srcLang);
            if (corrRes) {
                resolvedEnWord = corrWord;
                if (isUntranslated(bestTr, clean) && !isUntranslated(corrRes.text, corrWord)) {
                    bestTr = corrRes.text.trim();
                }
                mergeDetailsInto(activeRes, corrRes);
            }
        }

        // Büyük harfli kelime çevrilmediyse veya sözlük boşsa küçük harfle dene
        if ((isUntranslated(bestTr, clean) || activeRes.dictTerms.length === 0) && resolvedEnWord !== resolvedEnWord.toLowerCase()) {
            const lowerRes = await this.translateGoogleWithDetails(resolvedEnWord.toLowerCase(), 'tr', srcLang === 'auto' ? 'en' : srcLang);
            if (lowerRes) {
                if (isUntranslated(bestTr, clean) && !isUntranslated(lowerRes.text, clean)) {
                    bestTr = lowerRes.text.trim();
                }
                mergeDetailsInto(activeRes, lowerRes);
                if (lowerRes.correctedQuery && norm(lowerRes.correctedQuery) !== norm(resolvedEnWord)) {
                    const corrRes2 = await this.translateGoogleWithDetails(lowerRes.correctedQuery.toLowerCase(), 'tr', 'en');
                    if (corrRes2) {
                        resolvedEnWord = lowerRes.correctedQuery.trim();
                        if (isUntranslated(bestTr, clean) && !isUntranslated(corrRes2.text, resolvedEnWord)) {
                            bestTr = corrRes2.text.trim();
                        }
                        mergeDetailsInto(activeRes, corrRes2);
                    }
                }
            }
        }

        // Hâlâ çevrilmediyse (örn. "Brusier" -> "bruiser" harf yer değiştirmesi veya "a <word>" bağlamı)
        const singleWord = norm(resolvedEnWord);
        if (isUntranslated(bestTr, clean) && singleWord.length >= 3 && /^[a-z]+$/i.test(singleWord)) {
            const phraseRes = await this.translateGoogleWithDetails(`a ${singleWord}`, 'tr', 'en');
            if (phraseRes) {
                if (phraseRes.correctedQuery) {
                    const corrWord = phraseRes.correctedQuery.replace(/^an?\s+/i, '').trim();
                    if (corrWord && norm(corrWord) !== singleWord) {
                        resolvedEnWord = corrWord;
                        const cwRes = await this.translateGoogleWithDetails(corrWord.toLowerCase(), 'tr', 'en');
                        if (cwRes) {
                            if (!isUntranslated(cwRes.text, corrWord)) bestTr = cwRes.text.trim();
                            mergeDetailsInto(activeRes, cwRes);
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

            if ((isUntranslated(bestTr, clean) || activeRes.dictTerms.length === 0) && singleWord.length >= 4 && singleWord.length <= 14) {
                const transpositions = [];
                for (let i = 1; i < singleWord.length - 1; i++) {
                    if (singleWord[i] !== singleWord[i + 1]) {
                        const swapped = singleWord.slice(0, i) + singleWord[i + 1] + singleWord[i] + singleWord.slice(i + 2);
                        if (!transpositions.includes(swapped)) transpositions.push(swapped);
                    }
                }
                if (singleWord.length >= 5 && singleWord[0] !== singleWord[1]) {
                    const swapped0 = singleWord[1] + singleWord[0] + singleWord.slice(2);
                    if (!transpositions.includes(swapped0)) transpositions.push(swapped0);
                }

                if (transpositions.length > 0) {
                    const batchTr = await this.translateGoogle(transpositions.join('\n'), 'tr', 'en');
                    const trLines = (batchTr || '').split('\n').map(l => l.trim());
                    for (let k = 0; k < transpositions.length; k++) {
                        const candEn = transpositions[k];
                        const candTr = trLines[k] || '';
                        if (candTr && !isUntranslated(candTr, candEn) && !isUntranslated(candTr, singleWord)) {
                            const verifyRes = await this.translateGoogleWithDetails(candEn, 'tr', 'en');
                            if (verifyRes && ((verifyRes.dictTerms && verifyRes.dictTerms.length > 0) || !isUntranslated(verifyRes.text, candEn))) {
                                resolvedEnWord = candEn;
                                bestTr = (!isUntranslated(verifyRes.text, candEn)) ? verifyRes.text.trim() : verifyRes.dictTerms[0];
                                mergeDetailsInto(activeRes, verifyRes);
                                break;
                            }
                        }
                    }
                }
            }
        }

        // Eğer çekimli bir kelimeyse ve sözlükte baseForm varsa (örn. "shattered" -> "shatter"), baseForm'un tanımlarını da al
        const baseFormCandidate = activeRes.dictEntries.find(e => e.baseForm && norm(e.baseForm) !== norm(resolvedEnWord));
        if (activeRes.definitions.length === 0 && baseFormCandidate && baseFormCandidate.baseForm) {
            const baseRes = await this.translateGoogleWithDetails(baseFormCandidate.baseForm.toLowerCase(), 'tr', 'en');
            if (baseRes) mergeDetailsInto(activeRes, baseRes);
        }

        // 2. Eğer Google'ın dt=md tanımı boşsa (örn. "bruiser"), harici İngilizce sözlükten (dictionaryapi.dev) tanımları çek
        if (activeRes.definitions.length === 0) {
            const extDefs = await this.fetchExternalEnglishDefinitions(resolvedEnWord);
            if (extDefs.length > 0) {
                activeRes.definitions.push(...extDefs);
                if (!activeRes.posLabel && extDefs[0].posTr) {
                    activeRes.posLabel = extDefs[0].posTr;
                }
            }
        }

        // Ters eş anlamlılarda "fighter", "brawler", "thug", "bruiser", "boxer" geçen kelimeler için (örn. bruiser)
        // günlük/roman dilindeki "kabadayı" ve "dövüşçü" karşılıklarını da aday havuzuna ekle
        const allReverseEn = new Set();
        activeRes.dictEntries.forEach(e => (e.reverse || []).forEach(r => allReverseEn.add(r)));
        if (norm(resolvedEnWord) === 'bruiser' || (allReverseEn.has('bruiser') && (allReverseEn.has('fighter') || allReverseEn.has('boxer')))) {
            ['kabadayı', 'dövüşçü'].forEach(extraTr => {
                if (!activeRes.dictTerms.some(t => norm(t) === norm(extraTr))) {
                    activeRes.dictTerms.unshift(extraTr);
                }
            });
        }

        // 3. Bağlam cümlesinden kelimenin geçtiği spesifik cümleyi ayıkla
        let targetSentence = (contextSentence || "").replace(/\s+/g, " ").trim();
        if (targetSentence) {
            const sents = (targetSentence.match(/[^.!?…]+(?:[.!?…]+["”'’)\]]*|$)/g) || [targetSentence])
                .map(s => s.trim())
                .filter(Boolean);
            if (sents.length > 1) {
                const lowerClean = clean.toLowerCase();
                const lowerResolved = resolvedEnWord.toLowerCase();
                const matchedSent = sents.find(s => s.toLowerCase().includes(lowerClean) || s.toLowerCase().includes(lowerResolved));
                if (matchedSent) targetSentence = matchedSent;
            }
        }

        // Cümle içinde yazım hatası varsa ("Brusier" gibi), cümle çevirisinin doğru çıkması için düzeltilmiş kelimeyi ("bruiser") yerleştir
        let sentenceForContext = targetSentence;
        if (sentenceForContext && norm(clean) !== norm(resolvedEnWord)) {
            const escClean = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            sentenceForContext = sentenceForContext.replace(new RegExp(escClean, 'gi'), resolvedEnWord);
        }

        // Cümledeki kelimeyi «...» içine alarak bağlamsal kelime çevirisini yakalamak için işaretli cümle oluştur
        let markedSentence = "";
        if (sentenceForContext && sentenceForContext.split(/\s+/).length > 1) {
            const escRes = resolvedEnWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const wordRegex = new RegExp(`\\b${escRes}\\b`, 'i');
            if (wordRegex.test(sentenceForContext)) {
                markedSentence = sentenceForContext.replace(wordRegex, `«$&»`);
            } else {
                markedSentence = sentenceForContext.replace(resolvedEnWord, `«${resolvedEnWord}»`);
            }
        }

        // 4. Mevcut İngilizce tanımları (definitions) cümle bağlamına göre puanla ve en uygun 1-2 tanımı seç
        let topDefs = [];
        if (activeRes.definitions.length > 0) {
            const contextLower = `${sentenceForContext} ${contextSentence}`.toLowerCase();
            const contextTokens = contextLower.split(/[^a-z0-9]+/).filter(w => w.length >= 3);

            // Eğer sayfa çevrilmişse ve preferredTrHint varsa, onun İngilizce ters eş anlamlılarını bul
            const preferredReverseEn = new Set();
            if (preferredTrHint) {
                const nPref = norm(preferredTrHint);
                activeRes.dictEntries.forEach(e => {
                    if (norm(e.word) === nPref || norm(e.word).includes(nPref) || nPref.includes(norm(e.word))) {
                        (e.reverse || []).forEach(r => preferredReverseEn.add(r));
                    }
                });
            }

            const scoredDefs = activeRes.definitions.map((d, idx) => {
                let score = 50 - idx * 3; // İlk tanımlar varsayılan olarak biraz önde başlar
                const glossLower = (d.gloss || "").toLowerCase();
                const exLower = (d.example || "").toLowerCase();

                // Synset eşleşmesi
                const matchingSynset = activeRes.synsets.find(s => s.definitionId && s.definitionId === d.definitionId);
                const synList = [
                    ...(matchingSynset ? matchingSynset.synonyms : []),
                    ...(Array.isArray(d.synonyms) ? d.synonyms : [])
                ];

                // Bağlam kelimeleriyle örtüşme
                contextTokens.forEach(ct => {
                    if (ct !== norm(resolvedEnWord)) {
                        if (glossLower.includes(ct) || exLower.includes(ct)) score += 18;
                        if (synList.some(syn => syn.includes(ct))) score += 22;
                    }
                });

                // Seçilen Türkçe ipucunun (preferredTrHint) ters eş anlamlılarıyla örtüşme
                preferredReverseEn.forEach(rev => {
                    if (glossLower.includes(rev)) score += 25;
                    if (synList.some(syn => syn.includes(rev))) score += 30;
                });

                // "(by extension)" veya karakter/kişi/savaşçı bağlamı iyileştirmesi (örn. bruiser: "a tall, strong, heavily built man...; a thug" vs "A machine for bruising oats")
                if (/\b(archaic|obsolete|historical|rare|oats|machine for)\b/i.test(glossLower)) {
                    score -= 35;
                }
                if (/\b(by extension|person|someone|man|fighter|thug|warrior|combat)\b/i.test(glossLower)) {
                    score += 12;
                }

                return { ...d, score, synList };
            });

            scoredDefs.sort((a, b) => b.score - a.score);
            topDefs = scoredDefs.slice(0, 2);
        }

        const cleanGlossText = (g) => (g || "")
            .replace(/^\([^)]+\)\s*/g, "") // Baştaki "(by extension)" gibi etiketleri temizle
            .replace(/\s+/g, " ")
            .trim();

        // 5. Cümleyi, işaretli cümleyi ve en iyi 1-2 tanımı TEK BİR toplu (batch) sorguda Türkçeye çevir
        const batchQueue = [];
        const idxSentence = (sentenceForContext && sentenceForContext.split(/\s+/).length > 1) ? (batchQueue.push(sentenceForContext) - 1) : -1;
        const idxMarked = markedSentence ? (batchQueue.push(markedSentence) - 1) : -1;
        const defIndices = topDefs.map(d => batchQueue.push(cleanGlossText(d.gloss)) - 1);

        let batchTranslatedLines = [];
        if (batchQueue.length > 0) {
            const batchRawTr = await this.translateGoogle(batchQueue.join('\n'), 'tr', srcLang === 'auto' ? 'en' : srcLang);
            batchTranslatedLines = (batchRawTr || '').split('\n').map(l => l.trim());
        }

        const trSentence = idxSentence !== -1 ? (batchTranslatedLines[idxSentence] || "") : "";
        const trMarked = idxMarked !== -1 ? (batchTranslatedLines[idxMarked] || "") : "";

        // 6. Tüm olası Türkçe karşılıkların listesini oluştur
        const rawCandidatePool = [];
        if (preferredTrHint && !isUntranslated(preferredTrHint, clean) && preferredTrHint.split(/\s+/).length <= 3) {
            rawCandidatePool.push(preferredTrHint.trim());
        }
        if (bestTr && !isUntranslated(bestTr, clean) && !isUntranslated(bestTr, resolvedEnWord)) {
            rawCandidatePool.push(bestTr);
        }
        activeRes.dictTerms.forEach(t => {
            if (t && !isUntranslated(t, clean) && !isUntranslated(t, resolvedEnWord)) {
                rawCandidatePool.push(t);
            }
        });
        activeRes.altTerms.forEach(t => {
            if (t && !isUntranslated(t, clean) && !isUntranslated(t, resolvedEnWord)) {
                rawCandidatePool.push(t);
            }
        });

        // 7. Cümlede geçen spesifik Türkçe karşılığı (contextualWord) belirle
        let contextualWord = "";

        // a) Sayfa zaten Türkçeye çevrilmişse ve kullanıcı Türkçe kelimeye tıkladıysa doğrudan o kelime cümledeki anlamıdır
        if (preferredTrHint && !isUntranslated(preferredTrHint, clean) && preferredTrHint.split(/\s+/).length <= 3) {
            contextualWord = preferredTrHint.trim();
        }

        // b) Çevrilmiş cümlede (trSentence) aday Türkçe kelimelerden hangisinin (veya kökünün) geçtiğini kontrol et
        // Örn. "He spoke with deep conviction." -> "Derin bir inançla konuşuyordu." içinde "inanç" geçer!
        if (!contextualWord && trSentence) {
            const trSentLower = trSentence.toLowerCase();
            for (const cand of rawCandidatePool) {
                const cNorm = norm(cand);
                if (!cNorm || cNorm.length < 2) continue;
                // Tam kelime veya Türkçe ünlü yumuşaması / çekim eki uyumu (örn. inanç -> inançla, dövüşçü -> dövüşçüdür)
                const stem = cNorm.length >= 5 ? cNorm.slice(0, cNorm.length - 1) : cNorm;
                if (trSentLower.includes(cNorm) || (stem.length >= 4 && trSentLower.includes(stem))) {
                    contextualWord = cand;
                    break;
                }
            }
        }

        // c) İşaretli cümleden («word» -> "...") tırnak içindeki bağlamsal çeviriyi çek
        // Örn. "She «banked» the plane..." -> "Uçağı keskin bir şekilde sola doğru "yatırdı"."
        if (!contextualWord && trMarked) {
            const quoteMatch = trMarked.match(/[«"“”]([^»"“”]{1,35})[»"“”]/);
            if (quoteMatch && quoteMatch[1]) {
                const qWord = quoteMatch[1].trim();
                if (qWord && !isUntranslated(qWord, clean) && !isUntranslated(qWord, resolvedEnWord)) {
                    contextualWord = qWord;
                }
            }
        }

        // d) Eğer hâlâ bulunamadıysa en güçlü sözlük/çeviri karşılığını kullan
        if (!contextualWord) {
            contextualWord = rawCandidatePool[0] || bestTr || clean;
        }

        // Cümledeki anlamı da olası Türkçe kelimeler listesinin en başına ekle ve tekilleştir
        const possibleMeanings = [];
        const seenNorms = new Set();
        [contextualWord, ...rawCandidatePool].forEach(item => {
            const cleanedItem = (item || "").trim();
            const nItem = norm(cleanedItem);
            if (
                cleanedItem &&
                nItem &&
                !seenNorms.has(nItem) &&
                nItem !== norm(clean) &&
                nItem !== norm(resolvedEnWord)
            ) {
                seenNorms.add(nItem);
                possibleMeanings.push(cleanedItem);
            }
        });

        // 8. Cümlede geçen anlamın açıklamasını (contextualExplanation) oluştur
        // Eğer 2 farklı tanım çevirdiysek, bulunan contextualWord ile en çok örtüşen tanımı seç
        let chosenDefTr = "";
        let chosenPosTr = activeRes.posLabel || "";
        if (defIndices.length > 0) {
            let bestDefIdx = 0;
            const cwNorm = norm(contextualWord);

            // contextualWord'ün İngilizce ters eş anlamlılarını bul
            const cwReverseEn = new Set();
            activeRes.dictEntries.forEach(e => {
                if (norm(e.word) === cwNorm || norm(e.word).includes(cwNorm) || cwNorm.includes(norm(e.word))) {
                    (e.reverse || []).forEach(r => cwReverseEn.add(r));
                }
            });

            let bestMatchScore = -999;
            topDefs.forEach((d, i) => {
                const trDefLine = batchTranslatedLines[defIndices[i]] || "";
                let mScore = d.score || 0;
                if (cwNorm && trDefLine.toLowerCase().includes(cwNorm.slice(0, Math.max(3, cwNorm.length - 1)))) {
                    mScore += 35;
                }
                const glossLower = (d.gloss || "").toLowerCase();
                cwReverseEn.forEach(rev => {
                    if (glossLower.includes(rev)) mScore += 30;
                    if (Array.isArray(d.synList) && d.synList.some(s => s.includes(rev))) mScore += 35;
                });
                if (mScore > bestMatchScore) {
                    bestMatchScore = mScore;
                    bestDefIdx = i;
                }
            });

            chosenDefTr = (batchTranslatedLines[defIndices[bestDefIdx]] || "").trim();
            if (topDefs[bestDefIdx] && topDefs[bestDefIdx].posTr) {
                chosenPosTr = topDefs[bestDefIdx].posTr;
            }
        }

        // Açıklama metnini biçimlendir (ilk harfi büyük, sonunda nokta)
        if (chosenDefTr) {
            chosenDefTr = chosenDefTr.charAt(0).toUpperCase() + chosenDefTr.slice(1);
            if (!/[.!?]$/.test(chosenDefTr)) chosenDefTr += ".";
        }

        let contextualExplanation = "";
        if (chosenDefTr && trSentence && sentenceForContext.split(/\s+/).length >= 3 && sentenceForContext.length <= 140) {
            contextualExplanation = `${chosenDefTr} (Cümlede: "${trSentence}")`;
        } else if (chosenDefTr) {
            contextualExplanation = chosenDefTr;
        } else if (trSentence && norm(trSentence) !== norm(contextualWord)) {
            contextualExplanation = `Bu cümlede "${contextualWord}" anlamında kullanılmıştır ("${trSentence}").`;
        } else if (possibleMeanings.length > 1) {
            contextualExplanation = `Metin bağlamında "${contextualWord}" (${possibleMeanings.slice(0, 3).join(' / ')}) anlamında kullanılmıştır.`;
        } else {
            contextualExplanation = `Metin bağlamında "${contextualWord}" anlamında kullanılmıştır.`;
        }

        return {
            primaryTr: contextualWord || bestTr || clean,
            possibleMeanings: possibleMeanings.slice(0, 7),
            contextualWord: contextualWord || bestTr || clean,
            contextualExplanation,
            posLabel: chosenPosTr
        };
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
