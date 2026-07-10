import { generateRaw, saveSettingsDebounced } from '../../../../script.js';
import { eventSource, event_types } from '../../../events.js';
import { callPopup } from '../../../../popup.js';
import { chat, saveChatDebounced } from '../../../../chat.js';
import { getContext, extension_settings } from '../../../extensions.js';

const extensionFolderPath = import.meta.url;
const extensionName = extensionFolderPath.split('/').slice(-2, -1)[0];

if (!window.DynamicQuestionsData) {
    window.DynamicQuestionsData = {
        enabled: true,
        isProcessing: false
    };
}

jQuery(async () => {
    try {
        if (eventSource && eventSource.on) {
            eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
            console.log('[DynamicQuestions] Плагин успешно загружен и хук MESSAGE_SENT установлен.');
        } else {
            console.error('[DynamicQuestions] eventSource не найден. Плагин не может быть инициализирован.');
        }

        const settingsHtml = await $.get(`/scripts/extensions/third-party/${extensionName}/settings.html`);

        const target = $("#extensions_settings2").length
            ? $("#extensions_settings2")
            : $("#extensions_settings");

        if (!target.length) {
            throw new Error("Extensions settings container not found");
        }

        target.append(settingsHtml);

        if (extension_settings[extensionName]) {
            window.DynamicQuestionsData.enabled = extension_settings[extensionName].enabled !== false;
        }

        $('#dq_enable_toggle').prop('checked', window.DynamicQuestionsData.enabled);

        $('#dq_enable_toggle').off('change').on('change', function() {
            window.DynamicQuestionsData.enabled = !!$(this).prop('checked');
            saveSettings();
        });
        
    } catch (e) {
        console.error('[DynamicQuestions] Init error:', e);
    }
});

function saveSettings() {
    extension_settings[extensionName] = {
        enabled: window.DynamicQuestionsData.enabled
    };
    saveSettingsDebounced();
}

async function fetchQuestionsFromLLM(userText) {
    const prompt = `Проанализируй следующий текст пользователя и сгенерируй ровно 2 релевантных вопроса с вариантами выбора (Да/Нет) для развития сюжета.
Верни строго и только валидный JSON в формате: {"q1": "текст вопроса 1", "q2": "текст вопроса 2"}.
Без маркдауна, без дополнительных пояснений.

Текст пользователя:
"${userText}"`;

    try {
        console.log('[DynamicQuestions] Отправка фонового запроса к LLM...');
        const responseText = await generateRaw(prompt, true);
        
        const cleanJson = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
        
        const parsed = JSON.parse(cleanJson);
        if (parsed.q1 && parsed.q2) {
            return parsed;
        } else {
            console.warn('[DynamicQuestions] LLM вернула JSON, но не в ожидаемом формате:', parsed);
            return null;
        }
    } catch (error) {
        console.error('[DynamicQuestions] Ошибка при генерации/парсинге вопросов:', error);
        return null;
    }
}

function askUserQuestions(questions) {
    return new Promise((resolve) => {
        const popupHtml = `
            <div class="dynamic-questions-container" style="text-align: left; margin: 10px;">
                <p><strong>Вопрос 1:</strong> ${questions.q1}</p>
                <select id="dq_ans1" class="text_pole">
                    <option value="Да">Да</option>
                    <option value="Нет">Нет</option>
                </select>
                <br><br>
                <p><strong>Вопрос 2:</strong> ${questions.q2}</p>
                <select id="dq_ans2" class="text_pole">
                    <option value="Да">Да</option>
                    <option value="Нет">Нет</option>
                </select>
            </div>
        `;

        callPopup(popupHtml, 'text', '', {
            okButton: 'Подтвердить',
            cancelButton: 'Пропустить',
            wide: false
        }).then((result) => {
            if (result) {
                const a1 = document.getElementById('dq_ans1').value;
                const a2 = document.getElementById('dq_ans2').value;
                resolve({ a1, a2 });
            } else {
                resolve(null);
            }
        });
    });
}

async function onMessageSent(messageId) {
    if (!window.DynamicQuestionsData.enabled) return;
    if (window.DynamicQuestionsData.isProcessing) return;

    const context = getContext();
    const chatData = context.chat || chat;
    
    const msg = chatData.find(m => m.mes === document.querySelector(`.mes[mesid="${messageId}"]`)?.innerText || m.is_user && !m.is_system); 
    const lastUserMessage = chatData[chatData.length - 1]; 
    
    if (!lastUserMessage || !lastUserMessage.is_user) return;
    
    window.DynamicQuestionsData.isProcessing = true;
    if (typeof window.StopGeneration === 'function') {
        window.StopGeneration();
    }

    const originalText = lastUserMessage.mes;
    
    const questions = await fetchQuestionsFromLLM(originalText);
    
    if (questions) {
        const answers = await askUserQuestions(questions);
        
        if (answers) {
            const systemNote = `\n[Развитие сюжета: {${questions.q1}} -> ${answers.a1}; {${questions.q2}} -> ${answers.a2}]`;
            
            lastUserMessage.mes = originalText + systemNote;
            
            const mesDiv = document.querySelector(`.mes_text[mesid="${chatData.length - 1}"]`);
            if (mesDiv) {
                mesDiv.innerHTML = originalText + ` <br><i>${systemNote}</i>`;
            }
            
            saveChatDebounced();
        }
    }
    
    if (typeof window.Generate === 'function') {
        await window.Generate("normal");
    }
    
    window.DynamicQuestionsData.isProcessing = false;
}
