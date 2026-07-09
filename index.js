import { eventSource, event_types } from '../../../../script.js';
import { generateRaw } from '../../../../script.js';
import { callPopup } from '../../../../popup.js';
import { chat, saveChatDebounced } from '../../../../chat.js';
import { getContext, extension_settings } from '../../../../extensions.js';

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
        // Мы не вызываем getContext() здесь, так как ST может быть не до конца инициализирован!
        // Вместо этого используем импортированный объект extension_settings
        
        // Инициализация настроек
        if (!extension_settings[extensionName]) {
            extension_settings[extensionName] = { enabled: true };
        }
        isPluginEnabled = extension_settings[extensionName].enabled !== false;

        // Используем встроенный HTML, чтобы избежать ошибок 404 при загрузке файлов
        const settingsHtml = `
<div id="dynamic_questions_settings" class="dynamic-questions-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>❓ Dynamic Questions</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content" style="padding: 10px;">
      <div class="dynamic-questions-section">
        <label class="checkbox_label" title="Включить или выключить генерацию вопросов">
          <input id="dq_enable_toggle" type="checkbox" />
          <span>Включить Dynamic Questions (ON / OFF)</span>
        </label>
      </div>
    </div>
  </div>
</div>
        `;

        // Функция для инъекции после появления контейнера
        let injectAttempts = 0;
        const injectSettings = () => {
            const target = $("#extensions_settings2").length
              ? $("#extensions_settings2")
              : $("#extensions_settings");

            if (!target.length) {
                injectAttempts++;
                if (injectAttempts > 10) {
                    // ЕСЛИ НЕ НАШЛИ МЕНЮ РАСШИРЕНИЙ - ВЫВОДИМ ПОВЕРХ ВСЕГО ОКНА ДЛЯ ПРОВЕРКИ
                    if ($("#dq_floating_fallback").length) return;
                    $('body').append(`
                        <div id="dq_floating_fallback" style="position:fixed; top:50px; left:50px; z-index:999999; background:#222; border:2px solid red; padding:15px; border-radius:10px; color:white;">
                            <b>🚨 Dynamic Questions Fallback</b><br>
                            Меню расширений не найдено!<br>
                            <label><input type="checkbox" id="dq_enable_toggle_float" ${isPluginEnabled ? 'checked' : ''}> ВКЛЮЧИТЬ ПЛАГИН</label>
                        </div>
                    `);
                    $('#dq_enable_toggle_float').on('change', function() {
                        isPluginEnabled = !!$(this).prop('checked');
                        const ctx = getContext();
                        if (ctx.extension_settings) {
                            if (!ctx.extension_settings[extensionName]) ctx.extension_settings[extensionName] = {};
                            ctx.extension_settings[extensionName].enabled = isPluginEnabled;
                        }
                        if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
                    });
                    console.error('[DynamicQuestions] ОШИБКА: Контейнер настроек не найден, выведен резервный интерфейс!');
                    return;
                }
                
                // Ждем пока ST создаст контейнер
                setTimeout(injectSettings, 500);
                return;
            }

            if ($("#dynamic_questions_settings").length) return; // Уже добавлено

            target.append(settingsHtml);
            
            // Устанавливаем начальное состояние чекбокса
            $('#dq_enable_toggle').prop('checked', isPluginEnabled);
            
            // Привязываем события
            $('#dq_enable_toggle').off('change').on('change', function() {
                isPluginEnabled = !!$(this).prop('checked');
                
                const ctx = getContext();
                if (ctx.extension_settings) {
                    if (!ctx.extension_settings[extensionName]) ctx.extension_settings[extensionName] = {};
                    ctx.extension_settings[extensionName].enabled = isPluginEnabled;
                }
                
                if (typeof ctx.saveSettingsDebounced === 'function') {
                    ctx.saveSettingsDebounced();
                } else if (typeof window.saveSettingsDebounced === 'function') {
                    window.saveSettingsDebounced();
                }
            });
            console.log('[DynamicQuestions] Интерфейс успешно отрисован в меню!');
        };
        
        injectSettings();

        // В зависимости от версии ST, событие может называться MESSAGE_SENT или USER_MESSAGE_RENDERED
        if (eventSource && eventSource.on) {
            eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
            console.log('[DynamicQuestions] Плагин успешно загружен и хук MESSAGE_SENT установлен.');
        } else {
            console.error('[DynamicQuestions] eventSource не найден. Плагин не может быть инициализирован.');
        }
    } catch (e) {
        console.error('[DynamicQuestions] Init error:', e);
    }
});
