// ================= ÇEVİRİ VE SESLENDİRME MODÜLÜ (js/translate.js) =================

const translateService = {
    postProcessTranslation(text) {
        if (!text || typeof text !== 'string') return text;
        // Fix common Google translation typos: barier -> bariyer
        return text.replace(/barier/gi, match => match.startsWith('B') ? 'Bariyer' : 'bariyer');
    },

    // 1. Ücretsiz Google Translate Entegrasyonu
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
