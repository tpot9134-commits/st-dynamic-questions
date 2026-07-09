import { eventSource, event_types } from '../../../../script.js';
import { generateRaw } from '../../../../script.js';
import { callPopup } from '../../../../popup.js';
import { chat, saveChatDebounced } from '../../../../chat.js';
import { getContext } from '../../../../extensions.js';

const extensionName = 'dynamic-questions';

/**
 * Плагин: Dynamic Questions
 * Описание: Перехватывает сообщение пользователя, делает фоновый запрос к LLM для генерации 2 вопросов
 * по сюжету, предлагает выбор Да/Нет в модальном окне и прикрепляет результат к сообщению.
 */

// Флаг для предотвращения зацикливания, если мы сами триггерим продолжение генерации
let isProcessing = false;
// Флаг включения/выключения плагина
let isPluginEnabled = true;

/**
 * Функция для генерации вопросов через текущее API (LLM).
 * @param {string} userText - Текст последнего сообщения пользователя.
 * @returns {Promise<Object|null>} - Парсированный JSON с вопросами или null в случае ошибки.
 */
async function fetchQuestionsFromLLM(userText) {
    const prompt = `Проанализируй следующий текст пользователя и сгенерируй ровно 2 релевантных вопроса с вариантами выбора (Да/Нет) для развития сюжета.
Верни строго и только валидный JSON в формате: {"q1": "текст вопроса 1", "q2": "текст вопроса 2"}.
Без маркдауна, без дополнительных пояснений.

Текст пользователя:
"${userText}"`;

    try {
        console.log('[DynamicQuestions] Отправка фонового запроса к LLM...');
        // Использование встроенной функции generateRaw для скрытого запроса (работает с большинством API в ST)
        const responseText = await generateRaw(prompt, true);
        
        // Очистка от возможного маркдауна (если модель вернула ```json ... ```)
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

/**
 * Отображение кастомного модального окна через callPopup (встроенный метод ST).
 * @param {Object} questions - Объект с вопросами {q1, q2}.
 * @returns {Promise<Object>} - Ответы пользователя {a1: 'Да'/'Нет', a2: 'Да'/'Нет'}.
 */
function askUserQuestions(questions) {
    return new Promise((resolve) => {
        // Формируем HTML для попапа
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

        // Вызываем встроенный popup ST
        callPopup(popupHtml, 'text', '', {
            okButton: 'Подтвердить',
            cancelButton: 'Пропустить',
            wide: false
        }).then((result) => {
            if (result) { // Нажали OK
                const a1 = document.getElementById('dq_ans1').value;
                const a2 = document.getElementById('dq_ans2').value;
                resolve({ a1, a2 });
            } else {
                resolve(null); // Пропустили
            }
        });
    });
}

/**
 * Обработчик отправки сообщения пользователем.
 * В ST событие MESSAGE_SENT срабатывает сразу после добавления сообщения в чат (но перед ответом).
 */
async function onMessageSent(messageId) {
    if (!isPluginEnabled) return;
    if (isProcessing) return;

    // В ST getContext() или chat[] хранит историю.
    const context = getContext();
    const chatData = context.chat || chat;
    
    // Находим только что отправленное сообщение
    const msg = chatData.find(m => m.mes === document.querySelector(`.mes[mesid="${messageId}"]`)?.innerText || m.is_user && !m.is_system); // Упрощенный поиск последнего сообщения
    const lastUserMessage = chatData[chatData.length - 1]; 
    
    if (!lastUserMessage || !lastUserMessage.is_user) return;
    
    // 1. Ставим генерацию ответа на паузу (останавливаем триггер ИИ)
    // В некоторых версиях ST можно вызвать встроенный StopGeneration()
    isProcessing = true;
    if (typeof window.StopGeneration === 'function') {
        window.StopGeneration();
    }

    const originalText = lastUserMessage.mes;
    
    // 2. Фоновый запрос
    const questions = await fetchQuestionsFromLLM(originalText);
    
    if (questions) {
        // 3. Вызов попапа
        const answers = await askUserQuestions(questions);
        
        if (answers) {
            // 4. Формируем системную ноту
            const systemNote = `\n[Развитие сюжета: {${questions.q1}} -> ${answers.a1}; {${questions.q2}} -> ${answers.a2}]`;
            
            // 5. Модифицируем текст сообщения
            lastUserMessage.mes = originalText + systemNote;
            
            // Обновляем текст в DOM
            const mesDiv = document.querySelector(`.mes_text[mesid="${chatData.length - 1}"]`);
            if (mesDiv) {
                mesDiv.innerHTML = originalText + ` <br><i>${systemNote}</i>`;
            }
            
            // Сохраняем изменения в чат
            saveChatDebounced();
        }
    }
    
    // 6. Возобновляем генерацию ИИ (отправляем в основной чат)
    if (typeof window.Generate === 'function') {
        await window.Generate("normal");
    }
    
    isProcessing = false;
}

// Регистрируем хук при загрузке плагина
jQuery(async () => {
    try {
        // В зависимости от версии ST, событие может называться MESSAGE_SENT или USER_MESSAGE_RENDERED
        if (eventSource && eventSource.on) {
            eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
            console.log('[DynamicQuestions] Плагин успешно загружен и хук MESSAGE_SENT установлен.');
        } else {
            console.error('[DynamicQuestions] eventSource не найден. Плагин не может быть инициализирован.');
        }

        // Загрузка интерфейса как в NoriMyn
        let settingsHtml = "";
        try {
            settingsHtml = await $.get(`/scripts/extensions/third-party/${extensionName}/settings.html`);
        } catch(e) {
            settingsHtml = await $.get(`/plugins/${extensionName}/settings.html`);
        }

        const target = $("#extensions_settings2").length
          ? $("#extensions_settings2")
          : $("#extensions_settings");

        if (!target.length) {
            throw new Error("Extensions settings container not found");
        }

        target.append(settingsHtml);
        
        // Инициализация настроек
        if (extension_settings && !extension_settings[extensionName]) {
            extension_settings[extensionName] = { enabled: true };
        }
        isPluginEnabled = extension_settings && extension_settings[extensionName] 
            ? extension_settings[extensionName].enabled !== false 
            : true;

        // Устанавливаем начальное состояние чекбокса
        $('#dq_enable_toggle').prop('checked', isPluginEnabled);
        
        // Привязываем события
        $('#dq_enable_toggle').off('change').on('change', function() {
            isPluginEnabled = !!$(this).prop('checked');
            
            if (extension_settings) {
                if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
                extension_settings[extensionName].enabled = isPluginEnabled;
            }
            
            const ctx = getContext();
            if (ctx && typeof ctx.saveSettingsDebounced === 'function') {
                ctx.saveSettingsDebounced();
            } else if (typeof window.saveSettingsDebounced === 'function') {
                window.saveSettingsDebounced();
            }
        });
        
    } catch (e) {
        console.error('[DynamicQuestions] Init error:', e);
    }
});
