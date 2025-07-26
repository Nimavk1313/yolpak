const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');

// Initialize Telegram Bot
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
    polling: {
        interval: 300,
    }
});

// Handle promise cancellation warning
process.env.NTBA_FIX_319 = 1;

let userDB = {};
let ordersDB = {}; // For storing completed orders

// --- Logging Helper ---
const log = (message, data) => {
    const dataString = data ? `\n${JSON.stringify(data, null, 2)}` : '';
    console.log(`[LOG] ${new Date().toISOString()} - ${message}${dataString}`);
};

// --- User & Order Database Management ---
try {
    if (fs.existsSync('db.json')) {
        log('Loading user database from db.json...');
        const data = fs.readFileSync('db.json', 'utf8');
        if (data) userDB = JSON.parse(data);
    }
    if (fs.existsSync('orders.json')) {
        log('Loading orders database from orders.json...');
        const data = fs.readFileSync('orders.json', 'utf8');
        if (data) ordersDB = JSON.parse(data);
    }
} catch (err) {
    console.error("Error loading database files:", err);
}

const saveUserDB = () => {
    try {
        fs.writeFileSync('db.json', JSON.stringify(userDB, null, 2), 'utf8');
        log('User database saved successfully.');
    } catch (err) {
        console.error("Error writing to db.json:", err);
    }
};

const saveOrder = (chatId, order) => {
    try {
        const orderId = new Date().toISOString();
        if (!ordersDB[chatId]) {
            ordersDB[chatId] = [];
        }
        ordersDB[chatId].push({ orderId, order });
        fs.writeFileSync('orders.json', JSON.stringify(ordersDB, null, 2), 'utf8');
        log('New order saved successfully.', { chatId, orderId });
    } catch (err) {
        console.error("Error writing to orders.json:", err);
    }
};


const userState = {};

// --- Helper Functions ---
const formatDateTime = (isoString) => {
    if (!isoString) return 'N/A';
    const date = new Date(isoString);
    const options = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
    return date.toLocaleDateString('en-US', options);
};

const formatTime = (isoString) => {
    if (!isoString) return 'N/A';
    const date = new Date(isoString);
    const options = { hour: '2-digit', minute: '2-digit', hour12: false };
    return date.toLocaleTimeString('en-US', options);
};

const formatSlotButtonText = (startISO, endISO) => {
    const startDate = new Date(startISO);
    const endDate = new Date(endISO);
    const startText = formatDateTime(startISO);
    if (startDate.toDateString() === endDate.toDateString()) {
        return `Pickup: ${startText} - Drop-off: ${formatTime(endISO)}`;
    } else {
        return `Pickup: ${startText} - Drop-off: ${formatDateTime(endISO)}`;
    }
};

const isValidTurkishPhoneNumber = (phone) => {
    if (!phone) return false;
    const cleaned = phone.replace(/[\s()-]/g, "").replace(/^(\+90|0)/, "");
    const turkishMobileRegex = /^(5[0345][0-9])\d{7}$/;
    return turkishMobileRegex.test(cleaned);
};

const isNumericString = (value) => value && !isNaN(value);
const isFourDigitsOrLess = (value) => /^\d{1,4}$/.test(value);

const parseTemplate = (text) => {
    const data = {};
    if (!text) return data;
    const lines = text.trim().split('\n');

    for (const line of lines) {
        const separatorIndex = line.indexOf(':');
        if (separatorIndex > 0) {
            let key = line.substring(0, separatorIndex).trim();
            const value = line.substring(separatorIndex + 1).trim();

            // Clean the key - remove markdown formatting and normalize
            key = key.replace(/\*+/g, '').replace(/\(optional\)/gi, '').trim().toLowerCase();

            // Skip empty values unless it's an optional field
            if (key && (value || key.includes('optional'))) {
               data[key] = value || '';
            }
        }
    }
    log('Parsed Template Data Block:', data);
    return data;
};

// --- Bot OnText and OnContact Handlers ---

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    log(`Received /start command from user ${chatId}`);
    delete userState[chatId];
    if (userDB[chatId] && userDB[chatId].token) {
        bot.sendMessage(chatId, 'Welcome back! You are already logged in.', {
            reply_markup: {
                keyboard: [['Submit New Order'], ['Add Funds', 'Check Balance']],
                resize_keyboard: true
            },
        });
    } else {
        bot.sendMessage(chatId, 'Welcome! Please provide your Turkish phone number to log in (e.g., 05321234567), or use the button below.', {
            reply_markup: { keyboard: [[{ text: 'Send Phone Number', request_contact: true }]], resize_keyboard: true },
        });
        userState[chatId] = { action: 'awaiting_phone_input' };
    }
});

bot.on('contact', async (msg) => {
    initiateLogin(msg.chat.id, msg.contact.phone_number);
});

bot.onText(/Submit New Order/, (msg) => {
    const chatId = msg.chat.id;
    log(`Received 'Submit New Order' from user ${chatId}`);
    if (userDB[chatId] && userDB[chatId].token) {
        bot.sendMessage(chatId, 'What type of order would you like to create?', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Single Order', callback_data: 'order_type_single' }],
                    [{ text: 'Group Order', callback_data: 'order_type_group' }]
                ]
            }
        });
    } else {
        bot.sendMessage(chatId, 'You need to be logged in to submit an order. Please send /start to begin.');
    }
});

bot.onText(/Add Funds|Check Balance/, async (msg) => {
    const chatId = msg.chat.id;
    log(`Received '${msg.text}' from user ${chatId}`);
    const userToken = userDB[chatId]?.token;
    if (!userToken) return bot.sendMessage(chatId, 'You need to be logged in. Please send /start.');

    const isAddingFunds = msg.text === 'Add Funds';
    const url = isAddingFunds
        ? 'https://yolpak-api.shinypi.net/payment/add?amount=1000'
        : 'https://yolpak-api.shinypi.net/payment/balance';
    const actionVerb = isAddingFunds ? 'adding funds' : 'checking balance';

    try {
        await bot.sendMessage(chatId, `Please wait while ${actionVerb}...`);
        const response = await axios.get(url, { headers: { Authorization: `Bearer ${userToken}` } });
        log(`API Response from ${url}`, response.data);
        if (response.data.isSuccess) {
            const message = isAddingFunds
                ? '✅ Successfully added funds! You can check your new balance.'
                : `Your current balance is: *${response.data.data}*`;
            await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } else {
            await bot.sendMessage(chatId, `❌ Failed to complete request: ${response.data.message || 'An unknown error occurred.'}`);
        }
    } catch (error) {
        const apiMessage = error.response?.data?.message || 'A critical error occurred.';
        log(`Error during ${actionVerb}`, { error: apiMessage });
        await bot.sendMessage(chatId, `❌ An error occurred: ${apiMessage}`);
    }
});

// --- Main Message Handler ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    log(`Received message from user ${chatId}`, { text: text, location: msg.location });

    const commands = ['/start', 'Submit New Order', 'Add Funds', 'Check Balance'];
    if (msg.contact || (text && commands.some(cmd => text.startsWith(cmd)))) {
        return;
    }

    const state = userState[chatId];
    if (!state || !state.action) {
        bot.sendMessage(chatId, "I'm not sure what you mean. Please send /start to begin.");
        return;
    }

    let messageHandled = true;
    switch (state.action) {
        case 'awaiting_phone_input':
            if (isValidTurkishPhoneNumber(text)) initiateLogin(chatId, text);
            else bot.sendMessage(chatId, "This doesn't seem to be a valid Turkish mobile number. Please try again.");
            break;
        case 'awaiting_otp':
            handleOtp(chatId, text);
            break;
        case 'awaiting_single_order_step':
            if (text === '⬅️ Back') {
                await bot.sendMessage(chatId, 'Going back...', { reply_markup: { remove_keyboard: true } });
                handleSingleOrderBackButton(chatId, state);
            } else {
                processSingleOrderStep(chatId, msg);
            }
            break;
        case 'awaiting_single_bulk_input':
            processSingleBulkInput(chatId, text);
            break;
        case 'awaiting_single_pickup_location':
            if (msg.location) {
                state.order.pickupAddress.latitude = msg.location.latitude;
                state.order.pickupAddress.longitude = msg.location.longitude;
                await bot.sendMessage(chatId, '✅ Pickup location saved.', { reply_markup: { remove_keyboard: true } });
                promptForSingleDropoffLocation(chatId);
            } else {
                bot.sendMessage(chatId, "Please use the 'Share Pickup Location' button to proceed.");
            }
            break;
        case 'awaiting_single_dropoff_location':
            if (msg.location) {
                state.order.dropAddress.latitude = msg.location.latitude;
                state.order.dropAddress.longitude = msg.location.longitude;
                await bot.sendMessage(chatId, '✅ Drop-off location saved.', { reply_markup: { remove_keyboard: true } });
                handleSingleParcelSize(chatId, '*Step 4: Parcel Size*');
            } else {
                bot.sendMessage(chatId, "Please use the 'Share Drop-off Location' button to proceed.");
            }
            break;
        case 'awaiting_pickup_bulk_input':
            processPickupBulkInput(chatId, text);
            break;
        case 'awaiting_pickup_location':
            if (msg.location) {
                state.order.pickupAddress.latitude = msg.location.latitude;
                state.order.pickupAddress.longitude = msg.location.longitude;
                await bot.sendMessage(chatId, '✅ Pickup location saved.', { reply_markup: { remove_keyboard: true } });
                promptForDropoffInput(chatId, state.currentDropIndex);
            } else {
                bot.sendMessage(chatId, "Please use the 'Share Pickup Location' button to proceed.");
            }
            break;
        case 'awaiting_dropoff_bulk_input':
            processDropoffBulkInput(chatId, text);
            break;
        case 'awaiting_dropoff_location':
            if (msg.location) {
                const dropIndex = state.currentDropIndex;
                state.order.orders[dropIndex].dropAddress.latitude = msg.location.latitude;
                state.order.orders[dropIndex].dropAddress.longitude = msg.location.longitude;
                await bot.sendMessage(chatId, `✅ Drop-off location for order #${dropIndex + 1} saved.`, { reply_markup: { remove_keyboard: true } });
                promptForParcelSize(chatId, dropIndex);
            } else {
                bot.sendMessage(chatId, "Please use the 'Share Location' button to proceed.");
            }
            break;
        default:
            messageHandled = false;
            break;
    }

    if (!messageHandled) {
        bot.sendMessage(chatId, "I'm not sure what you mean. Please use one of the buttons provided, or send /start to begin again.");
    }
});

// --- Callback Query Handler ---
bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const data = callbackQuery.data;
    const state = userState[chatId];

    log(`Received callback_query from user ${chatId}`, { data });
    bot.answerCallbackQuery(callbackQuery.id);

    if (data.startsWith('order_type_')) {
        try{
            await bot.editMessageText(`You selected: ${data.includes('single') ? 'Single Order' : 'Group Order'}.`, {
                chat_id: chatId, message_id: msg.message_id, reply_markup: null
            });
        } catch (error) {
            if (!error.response?.body?.description?.includes('message is not modified')) {
                log('Error editing message', error.response?.body || error.message);
            }
        }
        if (data.includes('group')) startGroupOrder(chatId);
        else promptForSingleOrderMode(chatId);
        return;
    }

    if (data.startsWith('order_mode_')) {
        const mode = data.split('_')[2];
        try{
            await bot.editMessageText(`You selected: ${mode === 'stepwise' ? 'Step-by-Step' : 'All at Once'}.`, {
                chat_id: chatId, message_id: msg.message_id, reply_markup: null
            });
        } catch (error) {
            if (!error.response?.body?.description?.includes('message is not modified')) {
                log('Error editing message', error.response?.body || error.message);
            }
        }
        if (mode === 'stepwise') startSingleOrder_Stepwise(chatId);
        else startSingleOrder_Bulk(chatId);
        return;
    }

    if (!state) return;

    if (data === 'cancel_order') {
        delete userState[chatId];
        try {
            await bot.editMessageText('Order cancelled.', { chat_id: chatId, message_id: msg.message_id });
        } catch (error) {
            if (!error.response?.body?.description?.includes('message is not modified')) {
                log('Error editing message', error.response?.body || error.message);
            }
        }
        return;
    }

    if (state.orderType === 'group') {
        handleGroupCallbacks(chatId, data, msg);
    } else if (state.orderType === 'single') {
        handleSingleCallbacks(chatId, data, msg);
    }
});


// --- Authentication ---
const initiateLogin = async (chatId, phoneNumber) => {
    log(`Initiating login for ${phoneNumber}`);
    try {
        await bot.sendMessage(chatId, 'Sending OTP...', { reply_markup: { remove_keyboard: true } });
        const url = 'https://yolpak-api.shinypi.net/auth/login-send-code';
        const response = await axios.post(url, { username: phoneNumber });
        log('API Response from /auth/login-send-code', response.data);
        if (response.data.isSuccess) {
            const otpCode = response.data.data;
            await bot.sendMessage(chatId, `An OTP has been sent. For testing, the code is: ${otpCode}\n\nPlease enter the OTP.`);
            userState[chatId] = { action: 'awaiting_otp', phone: phoneNumber };
        } else {
            await bot.sendMessage(chatId, `Failed to send OTP: ${response.data.message || 'Please try again.'}`);
        }
    } catch (error) {
        const apiMessage = error.response?.data?.message || 'A critical error occurred.';
        log('Error in initiateLogin', { error: apiMessage });
        await bot.sendMessage(chatId, `An error occurred while sending the OTP: ${apiMessage}`);
    }
};

const handleOtp = async (chatId, otp) => {
    const state = userState[chatId];
    if (!state || state.action !== 'awaiting_otp') return;
    log(`Handling OTP for ${state.phone}`);
    try {
        await bot.sendMessage(chatId, 'Verifying OTP...');
        const url = 'https://yolpak-api.shinypi.net/auth/login-check-code';
        const response = await axios.post(url, { username: state.phone, code: otp });
        log('API Response from /auth/login-check-code', response.data);
        if (response.data.isSuccess) {
            userDB[chatId] = { token: response.data.data.token, phone: state.phone };
            saveUserDB();
            delete userState[chatId];
            await bot.sendMessage(chatId, 'You have been successfully authenticated!', {
                reply_markup: {
                    keyboard: [['Submit New Order'], ['Add Funds', 'Check Balance']], resize_keyboard: true
                },
            });
        } else {
            await bot.sendMessage(chatId, `Invalid OTP: ${response.data.message || 'Please try again.'}`);
        }
    } catch (error) {
        const apiMessage = error.response?.data?.message || 'A critical error occurred.';
        log('Error in handleOtp', { error: apiMessage });
        await bot.sendMessage(chatId, `An error occurred while verifying the OTP: ${apiMessage}`);
    }
};


// =================================================================
// --- SINGLE ORDER FLOW ---
// =================================================================

const singleOrderStepOrder = [
    'pickup_fullName', 'pickup_phoneNumber', 'pickup_fullAddress', 'pickup_location', 'pickup_buildingNo', 'pickup_floor', 'pickup_unit', 'pickup_postalCode', 'pickup_note',
    'drop_fullName', 'drop_phoneNumber', 'drop_fullAddress', 'drop_location', 'drop_buildingNo', 'drop_floor', 'drop_unit', 'drop_postalCode', 'drop_note',
    'parcel_weight', 'parcel_size', 'parcel_content', 'parcel_value',
    'delivery_type',
    'finalize'
];

const promptForSingleOrderMode = (chatId) => {
    bot.sendMessage(chatId, 'How would you like to provide the order details?', {
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Step-by-Step (Guided)', callback_data: 'order_mode_stepwise' }],
                [{ text: 'All at Once (Template)', callback_data: 'order_mode_bulk' }]
            ]
        }
    });
};

// --- Single Order: Step-by-Step ---

const startSingleOrder_Stepwise = (chatId) => {
    log(`Starting new SINGLE order (Stepwise) for user ${chatId}`);
    userState[chatId] = {
        action: 'awaiting_single_order_step',
        orderType: 'single',
        step: 'pickup_fullName',
        history: ['pickup_fullName'],
        order: { isDraft: false, pickupAddress: {}, dropAddress: {}, parcel: {} },
    };
    askSingleOrderQuestion(chatId, 'pickup_fullName');
};

const askSingleOrderQuestion = (chatId, step) => {
    const state = userState[chatId];
    if (!state) return;
    state.step = step;
    log(`Asking single order step: ${step}`);

    const keyboard = [];
    if (step !== 'pickup_fullName') keyboard.push([{ text: '⬅️ Back', callback_data: 'go_back' }]);
    const skippableSteps = ['pickup_postalCode', 'pickup_note', 'drop_postalCode', 'drop_note', 'parcel_value'];
    if (skippableSteps.includes(step)) keyboard.push([{ text: '➡️ Skip', callback_data: `skip_step_${step}` }]);

    const questions = {
        pickup_fullName: "**Pickup Details**\nWhat is the sender's full name?",
        pickup_phoneNumber: "What is the sender's phone number?",
        pickup_fullAddress: "What is the full pickup address?",
        pickup_location: 'Please share the pickup location.',
        pickup_buildingNo: 'Building/Apartment Number?',
        pickup_floor: 'Floor?',
        pickup_unit: 'Unit?',
        pickup_postalCode: 'Postal Code? (optional)',
        pickup_note: 'Any notes for the driver? (optional)',
        drop_fullName: "\n**Drop-off Details**\nWhat is the recipient's full name?",
        drop_phoneNumber: "What is the recipient's phone number?",
        drop_fullAddress: "What is the full drop-off address?",
        drop_location: 'Please share the drop-off location.',
        drop_buildingNo: 'Building/Apartment Number?',
        drop_floor: 'Floor?',
        drop_unit: 'Unit?',
        drop_postalCode: 'Postal Code? (optional)',
        drop_note: 'Any notes for the driver? (optional)',
        parcel_weight: '\n**Parcel Details**\nWhat is the parcel weight (in grams)?',
        parcel_value: 'What is the estimated value of the parcel? (optional)',
    };

    const questionText = questions[step];
    if (questionText) {
        const options = { reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown' };
        if (step.endsWith('_location')) {
            options.reply_markup = {
                keyboard: [[{ text: `Share ${step.includes('pickup') ? 'Pickup' : 'Drop-off'} Location`, request_location: true }], ['⬅️ Back']],
                resize_keyboard: true, one_time_keyboard: true
            };
        }
        bot.sendMessage(chatId, questionText, options);
    } else {
        if (step === 'parcel_size') handleSingleParcelSize(chatId, "What is the parcel size?");
        else if (step === 'parcel_content') handleSingleParcelContent(chatId, "What are the contents of the parcel?");
        else if (step === 'delivery_type') handleSingleDeliveryType(chatId);
        else if (step === 'finalize') finalizeSingleOrder(chatId);
    }
};

const findNextSingleOrderStep = (order, currentStep) => {
    const startIndex = singleOrderStepOrder.indexOf(currentStep);
    if (startIndex === -1) return 'finalize';
    for (let i = startIndex + 1; i < singleOrderStepOrder.length; i++) {
        const nextStep = singleOrderStepOrder[i];
        const [objKey, fieldKey] = nextStep.split('_');
        let data;
        if (objKey === 'parcel') data = order.parcel?.[fieldKey];
        else if (objKey === 'delivery' && fieldKey === 'type') data = order.orderDeliveryType;
        else data = order[`${objKey}Address`]?.[fieldKey];
        if (data === undefined) return nextStep;
    }
    return 'finalize';
};

const processSingleOrderStep = (chatId, msg) => {
    const state = userState[chatId];
    if (!state || !state.order) return;
    const { order, step } = state;

    let isValid = true;
    let errorMessage = '';
    const [objKey, fieldKey] = step.split('_');
    const targetAddress = (objKey === 'pickup' || objKey === 'drop') ? order[`${objKey}Address`] : null;
    const targetParcel = (objKey === 'parcel') ? order.parcel : null;

    if (step.endsWith('_location')) {
        if (!msg.location) { isValid = false; errorMessage = 'Please use the button to share a location.'; }
        else {
            targetAddress.latitude = msg.location.latitude;
            targetAddress.longitude = msg.location.longitude;
            bot.sendMessage(chatId, 'Location received.', { reply_markup: { remove_keyboard: true } });
        }
    } else {
        const text = msg.text;
        if (!text) { isValid = false; errorMessage = 'Please provide a text response.'; }
        else if (step.endsWith('_phoneNumber') && !isValidTurkishPhoneNumber(text)) { isValid = false; errorMessage = "Invalid Turkish phone number."; }
        else if (step.endsWith('_buildingNo') && !isFourDigitsOrLess(text)) { isValid = false; errorMessage = 'Building number must be a number with 4 digits or less.';}
        else if (step.endsWith('_postalCode') && text && text.toLowerCase() !== 'skip' && !isNumericString(text)) { isValid = false; errorMessage = 'Postal code must only contain numbers.'; }
        else if (['floor', 'unit'].some(s => step.endsWith(s)) && !isFourDigitsOrLess(text)) { isValid = false; errorMessage = 'Floor/Unit must be a number with 4 digits or less.'}
        else if (['weight', 'value'].some(s => step.endsWith(s)) && (text.toLowerCase() !== 'skip' && !isNumericString(text))) { isValid = false; errorMessage = 'Please enter a valid number for this field.'}
        else {
            if (targetAddress) targetAddress[fieldKey] = text;
            if (targetParcel) targetParcel[fieldKey] = text;
        }
    }

    if (isValid) {
        log('Single order step processed successfully', { step: step, data: msg.text || msg.location });
        if (!state.history.includes(step)) state.history.push(step);
        const nextStep = findNextSingleOrderStep(order, step);
        askSingleOrderQuestion(chatId, nextStep);
    } else {
        log('Single order step validation failed', { step: step, error: errorMessage });
        bot.sendMessage(chatId, `There was an issue: ${errorMessage}\nPlease try again.`);
    }
};

// --- Single Order: All-at-Once ---

const startSingleOrder_Bulk = (chatId) => {
    log(`Starting new SINGLE order (Bulk) for user ${chatId}`);
    const template = `
*Step 1: Provide Text Details*
Please copy this template, fill in the details, and send it back. Location and other options will be asked next with buttons. Make sure to keep the '---' separators.

*Pickup Details*
Sender Name:
Sender Phone:
Full Address:
Building No:
Floor:
Unit:
Postal Code (optional):
Note (optional):
---
*Drop-off Details*
Recipient Name:
Recipient Phone:
Full Address:
Building No:
Floor:
Unit:
Postal Code (optional):
Note (optional):
---
*Parcel Details*
Weight (grams):
Value (optional):
`;
    bot.sendMessage(chatId, template, { parse_mode: 'Markdown' });
    userState[chatId] = {
        action: 'awaiting_single_bulk_input',
        orderType: 'single',
        history: ['awaiting_single_bulk_input'],
        order: { isDraft: false, pickupAddress: {}, dropAddress: {}, parcel: {} },
    };
};

const processSingleBulkInput = async (chatId, text) => {
    const state = userState[chatId];
    const { order } = state;
    const errors = [];

    // Find the actual sections by looking for key markers
    const pickupStart = text.toLowerCase().indexOf('pickup details');
    const dropoffStart = text.toLowerCase().indexOf('drop-off details');
    const parcelStart = text.toLowerCase().indexOf('parcel details');

    if (pickupStart === -1 || dropoffStart === -1 || parcelStart === -1) {
        errors.push("Template format not recognized. Please use the provided template with 'Pickup Details', 'Drop-off Details', and 'Parcel Details' sections.");
        await bot.sendMessage(chatId, `There were errors with your submission:\n- ${errors.join('\n- ')}\nPlease correct the template and send it again.`, {
            reply_markup: { inline_keyboard: [[{ text: '❌ Cancel Order', callback_data: 'cancel_order' }]] }
        });
        return;
    }

    // Extract sections based on their positions
    const pickupText = text.substring(pickupStart, dropoffStart);
    const dropoffText = text.substring(dropoffStart, parcelStart);
    const parcelText = text.substring(parcelStart);

    log('Processing pickup section:', pickupText);
    log('Processing dropoff section:', dropoffText);
    log('Processing parcel section:', parcelText);

    const pickupData = parseTemplate(pickupText);
    const dropoffData = parseTemplate(dropoffText);
    const parcelData = parseTemplate(parcelText);

    log('Parsed pickup data:', pickupData);
    log('Parsed dropoff data:', dropoffData);
    log('Parsed parcel data:', parcelData);

    // Parse pickup address data with flexible key matching
    order.pickupAddress = {
        fullName: pickupData['sender name'] || '',
        phoneNumber: pickupData['sender phone'] || '',
        fullAddress: pickupData['full address'] || '',
        buildingNo: pickupData['building no'] || '',
        floor: pickupData['floor'] || '',
        unit: pickupData['unit'] || '',
        postalCode: pickupData['postal code'] || pickupData['postal code (optional)'] || '',
        note: pickupData['note'] || pickupData['note (optional)'] || ''
    };

    // Parse dropoff address data with flexible key matching
    order.dropAddress = {
        fullName: dropoffData['recipient name'] || '',
        phoneNumber: dropoffData['recipient phone'] || '',
        fullAddress: dropoffData['full address'] || '',
        buildingNo: dropoffData['building no'] || '',
        floor: dropoffData['floor'] || '',
        unit: dropoffData['unit'] || '',
        postalCode: dropoffData['postal code'] || dropoffData['postal code (optional)'] || '',
        note: dropoffData['note'] || dropoffData['note (optional)'] || ''
    };

    // Parse parcel data with flexible key matching
    order.parcel = {
        weight: parcelData['weight (grams)'] || parcelData['weight'] || '',
        value: parcelData['value'] || parcelData['value (optional)'] || ''
    };

    // Clean up "skip" values
    if (order.pickupAddress.postalCode && order.pickupAddress.postalCode.toLowerCase() === 'skip') {
        order.pickupAddress.postalCode = '';
    }
    if (order.pickupAddress.note && order.pickupAddress.note.toLowerCase() === 'skip') {
        order.pickupAddress.note = '';
    }
    if (order.dropAddress.postalCode && order.dropAddress.postalCode.toLowerCase() === 'skip') {
        order.dropAddress.postalCode = '';
    }
    if (order.dropAddress.note && order.dropAddress.note.toLowerCase() === 'skip') {
        order.dropAddress.note = '';
    }
    if (order.parcel.value && order.parcel.value.toLowerCase() === 'skip') {
        order.parcel.value = '';
    }

    log('Final parsed order data:', order);

    // Validation
    if (!order.pickupAddress.fullName || order.pickupAddress.fullName.trim() === '') {
        errors.push("Pickup Details: 'Sender Name' is a required field.");
    }
    if (!isValidTurkishPhoneNumber(order.pickupAddress.phoneNumber)) {
        errors.push("Pickup Details: 'Sender Phone' is invalid or missing.");
    }
    if (!order.pickupAddress.fullAddress || order.pickupAddress.fullAddress.trim() === '') {
        errors.push("Pickup Details: 'Full Address' is required.");
    }
    if (!order.pickupAddress.buildingNo || !isFourDigitsOrLess(order.pickupAddress.buildingNo)) {
        errors.push("Pickup Details: 'Building No' must be a number with 4 digits or less.");
    }
    if (!order.pickupAddress.floor || !isFourDigitsOrLess(order.pickupAddress.floor)) {
        errors.push("Pickup Details: 'Floor' must be a number with 4 digits or less.");
    }
    if (!order.pickupAddress.unit || !isFourDigitsOrLess(order.pickupAddress.unit)) {
        errors.push("Pickup Details: 'Unit' must be a number with 4 digits or less.");
    }
    if (order.pickupAddress.postalCode && order.pickupAddress.postalCode.trim() !== '' && !isNumericString(order.pickupAddress.postalCode)) {
        errors.push("Pickup Details: 'Postal Code' must only contain numbers.");
    }

    if (!order.dropAddress.fullName || order.dropAddress.fullName.trim() === '') {
        errors.push("Drop-off Details: 'Recipient Name' is required.");
    }
    if (!isValidTurkishPhoneNumber(order.dropAddress.phoneNumber)) {
        errors.push("Drop-off Details: 'Recipient Phone' is invalid or missing.");
    }
    if (!order.dropAddress.fullAddress || order.dropAddress.fullAddress.trim() === '') {
        errors.push("Drop-off Details: 'Full Address' is required.");
    }
    if (!order.dropAddress.buildingNo || !isFourDigitsOrLess(order.dropAddress.buildingNo)) {
        errors.push("Drop-off Details: 'Building No' must be a number with 4 digits or less.");
    }
    if (!order.dropAddress.floor || !isFourDigitsOrLess(order.dropAddress.floor)) {
        errors.push("Drop-off Details: 'Floor' must be a number with 4 digits or less.");
    }
    if (!order.dropAddress.unit || !isFourDigitsOrLess(order.dropAddress.unit)) {
        errors.push("Drop-off Details: 'Unit' must be a number with 4 digits or less.");
    }
    if (order.dropAddress.postalCode && order.dropAddress.postalCode.trim() !== '' && !isNumericString(order.dropAddress.postalCode)) {
        errors.push("Drop-off Details: 'Postal Code' must only contain numbers.");
    }

    if (!order.parcel.weight || !isNumericString(order.parcel.weight)) {
        errors.push("Parcel Details: 'Weight (grams)' must be a valid number.");
    }
    if (order.parcel.value && order.parcel.value.trim() !== '' && !isNumericString(order.parcel.value)) {
        errors.push("Parcel Details: 'Value' must be a valid number.");
    }

    if (errors.length > 0) {
        log('Single bulk input validation failed', { errors });
        await bot.sendMessage(chatId, `There were errors with your submission:\n- ${errors.join('\n- ')}\nPlease correct the template and send it again.`, {
            reply_markup: { inline_keyboard: [[{ text: '❌ Cancel Order', callback_data: 'cancel_order' }]] }
        });
        return;
    }

    log('Single bulk input parsed successfully', { order });
    await bot.sendMessage(chatId, '✅ Text details saved. Now for the locations and parcel options.');
    promptForSinglePickupLocation(chatId);
};

const promptForSinglePickupLocation = (chatId) => {
    const state = userState[chatId];
    state.action = 'awaiting_single_pickup_location';
    if (state.history[state.history.length - 1] !== state.action) state.history.push(state.action);
    bot.sendMessage(chatId, '*Step 2: Pickup Location*', {
        parse_mode: 'Markdown',
        reply_markup: {
            keyboard: [[{ text: 'Share Pickup Location', request_location: true }]],
            resize_keyboard: true, one_time_keyboard: true
        }
    });
};

const promptForSingleDropoffLocation = (chatId) => {
    const state = userState[chatId];
    state.action = 'awaiting_single_dropoff_location';
    if (state.history[state.history.length - 1] !== state.action) state.history.push(state.action);
    bot.sendMessage(chatId, '*Step 3: Drop-off Location*', {
        parse_mode: 'Markdown',
        reply_markup: {
            keyboard: [[{ text: 'Share Drop-off Location', request_location: true }]],
            resize_keyboard: true, one_time_keyboard: true
        }
    });
};

// --- Single Order: Common Functions & Callbacks ---

const handleSingleCallbacks = async (chatId, data, msg) => {
    const state = userState[chatId];
    if (data === 'go_back') {
        handleSingleOrderBackButton(chatId, state, msg.message_id);
    } else if (data.startsWith('skip_step_')) {
        handleSingleOrderSkip(chatId, data.replace('skip_step_', ''));
        try {
            await bot.deleteMessage(chatId, msg.message_id).catch(console.error);
        } catch (error) {
            if (!error.response?.body?.description?.includes('message to delete not found')) {
                log('Error deleting message', error.response?.body || error.message);
            }
        }
    } else if (data.startsWith('parcel_size_')) {
        state.order.parcel.size = parseInt(data.replace('parcel_size_', ''), 10);
        try {
            await bot.editMessageText('Parcel size selected.', { chat_id: chatId, message_id: msg.message_id });
        } catch (error) {
            if (!error.response?.body?.description?.includes('message is not modified')) {
                log('Error editing message', error.response?.body || error.message);
            }
        }
        const nextTitle = state.action === 'awaiting_single_order_step' ? "What are the contents of the parcel?" : "*Step 5: Parcel Content*";
        if (state.history[state.history.length - 1] !== 'parcel_size') state.history.push('parcel_size');
        handleSingleParcelContent(chatId, nextTitle);
    } else if (data.startsWith('parcel_content_')) {
        state.order.parcel.orderContent = data.replace('parcel_content_', '');
        try {
            await bot.editMessageText('Parcel content selected.', { chat_id: chatId, message_id: msg.message_id });
        } catch (error) {
            if (!error.response?.body?.description?.includes('message is not modified')) {
                log('Error editing message', error.response?.body || error.message);
            }
        }
        if (state.history[state.history.length - 1] !== 'parcel_content') state.history.push('parcel_content');
        handleSingleDeliveryType(chatId);
    } else if (data.startsWith('delivery_type_')) {
        if (state.history[state.history.length - 1] !== 'delivery_type') state.history.push('delivery_type');
        handleSingleDeliveryTypeSelection(chatId, data.replace('delivery_type_', ''), msg);
    } else if (data.startsWith('slot_')) {
        handleSingleSlotSelection(chatId, data, msg.message_id);
    } else if (data === 'confirm_order') {
        try {
            await bot.editMessageText('Submitting your order...', { chat_id: chatId, message_id: msg.message_id, reply_markup: {} });
        } catch (error) {
            if (!error.response?.body?.description?.includes('message is not modified')) {
                log('Error editing message', error.response?.body || error.message);
            }
        }
        submitSingleOrder(chatId);
    }
};

const handleSingleOrderBackButton = (chatId, state, messageId) => {
    if (!state || !state.history || state.history.length <= 1) {
        bot.sendMessage(chatId, "You're at the beginning. You can /start over to cancel.");
        return;
    }

    try {
        if (messageId) bot.deleteMessage(chatId, messageId).catch(console.error);
    } catch (error) {
        if (!error.response?.body?.description?.includes('message to delete not found')) {
            log('Error deleting message', error.response?.body || error.message);
        }
    }
    const currentStep = state.history.pop();
    const previousStep = state.history[state.history.length - 1];
    log(`Back button pressed. From ${currentStep} to ${previousStep}`);

    // This switch handles the logic for going back in any single-order flow
    switch(previousStep) {
        case 'awaiting_single_bulk_input':
            startSingleOrder_Bulk(chatId);
            break;
        case 'awaiting_single_pickup_location':
            promptForSinglePickupLocation(chatId);
            break;
        case 'awaiting_single_dropoff_location':
            promptForSingleDropoffLocation(chatId);
            break;
        case 'parcel_size':
            handleSingleParcelSize(chatId, '*Step 4: Parcel Size*');
            break;
        case 'parcel_content':
            handleSingleParcelContent(chatId, '*Step 5: Parcel Content*');
            break;
        case 'delivery_type':
             handleSingleDeliveryType(chatId);
             break;
        default: // This handles the step-by-step flow
            const [objKey, fieldKey] = currentStep.split('_');
            if (state.order[`${objKey}Address`] && state.order[`${objKey}Address`][fieldKey]) {
                delete state.order[`${objKey}Address`][fieldKey];
            } else if (state.order[objKey] && state.order[objKey][fieldKey]) {
                delete state.order[objKey][fieldKey];
            }
            askSingleOrderQuestion(chatId, previousStep);
            break;
    }
};

const handleSingleOrderSkip = (chatId, stepToSkip) => {
    const state = userState[chatId];
    if (!state || !state.order) return;
    state.history.push(stepToSkip);
    const nextStep = findNextSingleOrderStep(state.order, stepToSkip);
    askSingleOrderQuestion(chatId, nextStep);
};

const handleSingleParcelSize = (chatId, title) => {
    bot.sendMessage(chatId, title, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Small', callback_data: 'parcel_size_1' }, { text: 'Medium', callback_data: 'parcel_size_2' }],
                [{ text: 'Large', callback_data: 'parcel_size_3' }, { text: 'Extra Large', callback_data: 'parcel_size_4' }],
                [{ text: '⬅️ Back', callback_data: 'go_back' }]
            ]
        }
    });
};

const handleSingleParcelContent = (chatId, title) => {
    bot.sendMessage(chatId, title, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Food', callback_data: 'parcel_content_Food' }, { text: 'Gifts', callback_data: 'parcel_content_Gifts' }],
                [{ text: 'Documents', callback_data: 'parcel_content_Documents' }, { text: 'Flower', callback_data: 'parcel_content_Flower' }],
                [{ text: 'Personal', callback_data: 'parcel_content_Personal' }, { text: 'Others', callback_data: 'parcel_content_Others' }],
                [{ text: '⬅️ Back', callback_data: 'go_back' }]
            ]
        }
    });
};

const handleSingleDeliveryType = (chatId) => {
    const title = "*Step 6: Delivery Option*";
    bot.sendMessage(chatId, title, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: 'On Demand', callback_data: 'delivery_type_OnDemand' }],
                [{ text: 'SlotTime', callback_data: 'delivery_type_SlotTime' }],
                [{ text: '⬅️ Back', callback_data: 'go_back' }]
            ],
        },
    });
};

const handleSingleDeliveryTypeSelection = async (chatId, deliveryType, msg) => {
    const state = userState[chatId];
    state.order.orderDeliveryType = deliveryType;

    if (deliveryType === 'SlotTime') {
        try {
            await bot.editMessageText('Fetching available time slots...', { chat_id: chatId, message_id: msg.message_id, reply_markup: {} });
            const url = 'https://yolpak-api.shinypi.net/order/sameDay-activeTimes';
            const response = await axios.get(url, { headers: { Authorization: `Bearer ${userDB[chatId].token}` } });
            log('API Response from /order/sameDay-activeTimes', response.data);
            if (!response.data.isSuccess) throw new Error(response.data.message || 'Failed to fetch slots.');

            const allSlots = response.data.data ? response.data.data.flat() : [];
            if (allSlots.length > 0) {
                const timeSlotButtons = allSlots.map(slot => {
                    // Format slot text with proper pickup and delivery times
                    let slotText = `Pickup: ${formatDateTime(slot.startDateTime)} - ${formatTime(slot.endDateTime)}`;
                    let deliveryStartTime = slot.startDateTime; // Default fallback
                    
                    if (slot.deliveries && slot.deliveries.length > 0) {
                        const deliverySlot = slot.deliveries[0];
                        deliveryStartTime = deliverySlot.startDateTime;
                        slotText += ` | Drop-off: ${formatDateTime(deliverySlot.startDateTime)} - ${formatTime(deliverySlot.endDateTime)}`;
                    }

                    return [{
                        text: slotText,
                        callback_data: `slot_${slot.id}|${slot.startDateTime}|${deliveryStartTime}`
                    }];
                });
                timeSlotButtons.push([{ text: '⬅️ Back', callback_data: 'go_back' }]);
                try{
                    await bot.editMessageText('Please choose a time slot.', {
                        chat_id: chatId, message_id: msg.message_id, reply_markup: { inline_keyboard: timeSlotButtons },
                    });
                } catch (error) {
                    if (!error.response?.body?.description?.includes('message is not modified')) {
                        log('Error editing message', error.response?.body || error.message);
                    }
                }
            } else { throw new Error('No available time slots found.'); }
        } catch (error) {
            log('Error fetching time slots', { error: error.message });
            try{
                await bot.editMessageText(`Sorry, I couldn't fetch the time slots: ${error.message}`, { chat_id: chatId, message_id: msg.message_id });
            } catch (error) {
                if (!error.response?.body?.description?.includes('message is not modified')) {
                    log('Error editing message', error.response?.body || error.message);
                }
            }
        }
    } else {
        try {
            await bot.editMessageText(`You selected "On Demand".`, { chat_id: chatId, message_id: msg.message_id, reply_markup: {} });
        } catch (error) {
            if (!error.response?.body?.description?.includes('message is not modified')) {
                log('Error editing message', error.response?.body || error.message);
            }
        }
        finalizeSingleOrder(chatId);
    }
};

const handleSingleSlotSelection = async (chatId, data, messageId) => {
    const state = userState[chatId];
    const [, slotId, pickupStart, deliveryStart] = data.split('|');

    // Set the pickup and delivery times correctly from the callback data
    state.order.pickupDateTime = pickupStart;
    state.order.dropOffDateTime = deliveryStart;
    
    log('Set pickup and dropoff times from slot selection', {
        slotId: slotId,
        pickupDateTime: state.order.pickupDateTime,
        dropOffDateTime: state.order.dropOffDateTime
    });

    try {
        await bot.editMessageText(`Time slot selected.`, { chat_id: chatId, message_id: messageId });
    } catch (error) {
        if (!error.response?.body?.description?.includes('message is not modified')) {
            log('Error editing message', error.response?.body || error.message);
        }
    }
    finalizeSingleOrder(chatId);
};

const finalizeSingleOrder = async (chatId) => {
    const state = userState[chatId];
    if (!state || !state.order) return;

    log('Finalizing single order', state.order);

    const { order } = state;
    const p = order.pickupAddress;
    const d = order.dropAddress;
    const parcel = order.parcel;
    const sizeMap = { 1: 'Small', 2: 'Medium', 3: 'Large', 4: 'Extra Large' };

    let summary = `*Please confirm your order details:*\n\n`;
    summary += `*Pickup Details*\n`;
    summary += `- Name: ${p.fullName || 'N/A'}\n`;
    summary += `- Phone: ${p.phoneNumber || 'N/A'}\n`;
    summary += `- Address: ${p.fullAddress || 'N/A'}\n`;
    summary += `- Location: ${p.latitude ? `[View on Map](https://www.google.com/maps?q=${p.latitude},${p.longitude})` : 'N/A'}\n`;
    summary += `- Building: ${p.buildingNo || 'N/A'}, Floor: ${p.floor || 'N/A'}, Unit: ${p.unit || 'N/A'}\n`;
    summary += `- Postal Code: ${p.postalCode || 'N/A'}\n`;
    summary += `- Note: ${p.note || 'N/A'}\n\n`;

    summary += `*Drop-off Details*\n`;
    summary += `- Name: ${d.fullName || 'N/A'}\n`;
    summary += `- Phone: ${d.phoneNumber || 'N/A'}\n`;
    summary += `- Address: ${d.fullAddress || 'N/A'}\n`;
    summary += `- Location: ${d.latitude ? `[View on Map](https://www.google.com/maps?q=${d.latitude},${d.longitude})` : 'N/A'}\n`;
    summary += `- Building: ${d.buildingNo || 'N/A'}, Floor: ${d.floor || 'N/A'}, Unit: ${d.unit || 'N/A'}\n`;
    summary += `- Postal Code: ${d.postalCode || 'N/A'}\n`;
    summary += `- Note: ${d.note || 'N/A'}\n\n`;

    summary += `*Parcel Details*\n`;
    summary += `- Weight: ${parcel.weight || 'N/A'}g\n`;
    summary += `- Size: ${sizeMap[parcel.size] || 'N/A'}\n`;
    summary += `- Content: ${parcel.orderContent || 'N/A'}\n`;
    summary += `- Value: ${parcel.value || 'N/A'}\n\n`;

    summary += `*Delivery Details*\n`;
    summary += `- Type: ${order.orderDeliveryType || 'N/A'}\n`;
    if (order.orderDeliveryType === 'SlotTime') {
        summary += `- Pickup Time: ${formatDateTime(order.pickupDateTime)}\n`;
        summary += `- Drop-off Time: ${formatDateTime(order.dropOffDateTime || order.pickupDateTime)}\n`;
    }

    await bot.sendMessage(chatId, summary, { parse_mode: 'Markdown' });
    await bot.sendMessage(chatId, "Confirm to submit?", {
        reply_markup: {
            inline_keyboard: [
                [{ text: '✅ Confirm Order', callback_data: 'confirm_order' }],
                [{ text: '⬅️ Back', callback_data: 'go_back' }, { text: '❌ Cancel', callback_data: 'cancel_order' }]
            ]
        }
    });
};

const submitSingleOrder = async (chatId) => {
    log(`Submitting single order for user ${chatId}`);
    const state = userState[chatId];
    if (!state || !state.order) return;
    const { order } = state;
    const userToken = userDB[chatId].token;

    if (order.orderDeliveryType === 'OnDemand') {
        const now = new Date().toISOString();
        order.pickupDateTime = now;
        order.dropOffDateTime = now;
    }

    const valueOrNull = (value) => (value === '' || isNaN(parseFloat(value))) ? null : parseFloat(value);

    const finalPayload = {
        pickupDateTime: order.pickupDateTime,
        dropOffDateTime: order.dropOffDateTime || order.pickupDateTime,
        orderDeliveryType: order.orderDeliveryType,
        isDraft: false,
        pickupAddress: { ...order.pickupAddress },
        dropAddress: { ...order.dropAddress },
        parcel: {
            weight: parseInt(order.parcel.weight) || 0,
            size: order.parcel.size,
            orderContent: order.parcel.orderContent,
            value: valueOrNull(order.parcel.value)
        }
    };
    log('Submitting final single order payload', finalPayload);

    try {
        const url = 'https://yolpak-api.shinypi.net/order/single';
        const response = await axios.post(url, finalPayload, { headers: { Authorization: `Bearer ${userToken}` } });
        log('API Response from /order/single', response.data);
        if (!response.data.isSuccess) throw new Error(response.data.errors ? JSON.stringify(response.data.errors) : (response.data.message || "Failed to submit order."));

        await bot.sendMessage(chatId, '✅ Your order has been successfully submitted! Thank you.', {
            reply_markup: {
                keyboard: [['Submit New Order'], ['Add Funds', 'Check Balance']], resize_keyboard: true,
            }
        });
        saveOrder(chatId, finalPayload);
    } catch (error) {
        let errorMessage = error.message;

        // Check if this is an API response error with more details
        if (error.response && error.response.data) {
            const apiError = error.response.data;
            log('API Error Response', apiError);

            // Check for specific error messages or balance issues
            if (apiError.message) {
                errorMessage = apiError.message;
            } else if (apiError.errors) {
                if (typeof apiError.errors === 'string') {
                    errorMessage = apiError.errors;
                } else if (Array.isArray(apiError.errors)) {
                    errorMessage = apiError.errors.join(', ');
                } else {
                    errorMessage = JSON.stringify(apiError.errors);
                }
            }

            // Check for balance-related errors specifically
            if (errorMessage.toLowerCase().includes('balance') || 
                errorMessage.toLowerCase().includes('insufficient') ||
                errorMessage.toLowerCase().includes('funds')) {
                errorMessage = `💰 ${errorMessage}\n\nYou can add funds using the 'Add Funds' button in the main menu.`;
            }
        }

        log('Error in submitSingleOrder', { error: errorMessage });
        await bot.sendMessage(chatId, `❌ An error occurred while submitting your order: ${errorMessage}`);
    } finally {
        delete userState[chatId];
    }
};


// =================================================================
// --- GROUP ORDER FLOW ---
// =================================================================

const startGroupOrder = (chatId) => {
    log(`Starting new GROUP order for user ${chatId}`);
    const template = `
*Step 1: Pickup Details*
Please copy this template, fill in the pickup details, and send it back.

Sender Name:
Sender Phone:
Full Address:
Building No:
Floor:
Unit:
Postal Code (optional):
Note (optional):
`;
    userState[chatId] = {
        action: 'awaiting_pickup_bulk_input',
        orderType: 'group',
        history: ['awaiting_pickup_bulk_input'],
        order: { isDraft: true, pickupAddress: {}, orders: [] },
        currentDropIndex: 0,
    };
    bot.sendMessage(chatId, template, { parse_mode: 'Markdown' });
};

const processPickupBulkInput = (chatId, text) => {
    const state = userState[chatId];
    const errors = [];
    const data = parseTemplate(text);

    state.order.pickupAddress = {
        fullName: data['sender name'],
        phoneNumber: data['sender phone'],
        fullAddress: data['full address'],
        buildingNo: data['building no'],
        floor: data['floor'],
        unit: data['unit'],
        postalCode: data['postal code'],
        note: data['note'],
    };

    const p = state.order.pickupAddress;
    if (!p.fullName) errors.push("Pickup Details: 'Sender Name' is a required field.");
    if (!isValidTurkishPhoneNumber(p.phoneNumber)) errors.push("Pickup Details: 'Sender Phone' is not a valid Turkish number.");
    if (!p.fullAddress) errors.push("Pickup Details: 'Full Address' is required.");
    if (!p.buildingNo || !isFourDigitsOrLess(p.buildingNo)) errors.push("Pickup Details: 'Building No' must be a number with 4 digits or less.");
    if (!p.floor || !isFourDigitsOrLess(p.floor)) errors.push("Pickup Details: 'Floor' must be a number with 4 digits or less.");
    if (!p.unit || !isFourDigitsOrLess(p.unit)) errors.push("Pickup Details: 'Unit' must be a number with 4 digits or less.");
    if (p.postalCode && p.postalCode.toLowerCase() !== 'skip' && !isNumericString(p.postalCode)) errors.push("Pickup Details: 'Postal Code' must only contain numbers.");


    if (errors.length > 0) {
        log('Group pickup input validation failed', { errors });
        bot.sendMessage(chatId, `There were errors with your submission:\n- ${errors.join('\n- ')}\nPlease correct the template and send it again.`, {
            reply_markup: { inline_keyboard: [[{ text: '❌ Cancel Order', callback_data: 'cancel_order' }]] }
        });
        return;
    }

    log('Group pickup details parsed successfully', p);
    promptForPickupLocation(chatId);
};

const promptForPickupLocation = (chatId) => {
    const state = userState[chatId];
    state.action = 'awaiting_pickup_location';
    if (state.history[state.history.length - 1] !== state.action) state.history.push(state.action);

    bot.sendMessage(chatId, '*Step 2: Pickup Location*', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'go_back' }]],
            keyboard: [[{ text: 'Share Pickup Location', request_location: true }]],
            resize_keyboard: true, one_time_keyboard: true
        }
    });
};

const promptForDropoffInput = (chatId, dropIndex) => {
    const state = userState[chatId];
    const stepName = `dropoff_input_${dropIndex}`;
    state.action = 'awaiting_dropoff_bulk_input';
    if (state.history[state.history.length - 1] !== stepName) state.history.push(stepName);

    const template = `
*Details for Order #${dropIndex + 1}*
Please provide the details for this drop-off.

Recipient Name:
Recipient Phone:
Full Address:
Building No:
Floor:
Unit:
Postal Code (optional):
Note (optional):
Weight (grams):
Value (optional):
`;
    bot.sendMessage(chatId, template, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'go_back' }]]
        }
    });

    if (!state.order.orders[dropIndex]) {
        state.order.orders[dropIndex] = { dropAddress: {}, parcel: {} };
    }
};

const processDropoffBulkInput = (chatId, text) => {
    const state = userState[chatId];
    const dropIndex = state.currentDropIndex;
    const currentOrder = state.order.orders[dropIndex];
    const errors = [];
    const data = parseTemplate(text);

    currentOrder.dropAddress = {
        fullName: data['recipient name'],
        phoneNumber: data['recipient phone'],
        fullAddress: data['full address'],
        buildingNo: data['building no'],
        floor: data['floor'],
        unit: data['unit'],
        postalCode: data['postal code'],
        note: data['note'],
    };
    currentOrder.parcel.weight = data['weight (grams)'];
    currentOrder.parcel.value = data['value'];

    const d = currentOrder.dropAddress;
    const p = currentOrder.parcel;

    if (!d.fullName) errors.push(`Order #${dropIndex+1}: 'Recipient Name' is required.`);
    if (!isValidTurkishPhoneNumber(d.phoneNumber)) errors.push(`Order #${dropIndex+1}: 'Recipient Phone' is invalid.`);
    if (!d.fullAddress) errors.push(`Order #${dropIndex+1}: 'Full Address' is required.`);
    if (!d.buildingNo || !isFourDigitsOrLess(d.buildingNo)) errors.push(`Order #${dropIndex+1}: 'Building No' must be a number with 4 digits or less.`);
    if (!d.floor || !isFourDigitsOrLess(d.floor)) errors.push(`Order #${dropIndex+1}: 'Floor' must be a number with 4 digits or less.`);
    if (!d.unit || !isFourDigitsOrLess(d.unit)) errors.push(`Order #${dropIndex+1}: 'Unit' must be a number with 4 digits or less.`);
    if (d.postalCode && d.postalCode.toLowerCase() !== 'skip' && !isNumericString(d.postalCode)) errors.push(`Order #${dropIndex+1}: 'Postal Code' must only contain numbers.`);
    if (!p.weight || !isNumericString(p.weight)) errors.push(`Order #${dropIndex+1}: 'Weight (grams)' must be a number.`);
    if (p.value && p.value.toLowerCase() !== 'skip' && !isNumericString(p.value)) errors.push(`Order #${dropIndex+1}: 'Value' must be a valid number.`);


    if (errors.length > 0) {
        log(`Group dropoff #${dropIndex+1} validation failed`, { errors });
        bot.sendMessage(chatId, `There were errors:\n- ${errors.join('\n- ')}\nPlease correct and send again.`, {
            reply_markup: { inline_keyboard: [[{ text: '❌ Cancel Order', callback_data: 'cancel_order' }]] }
        });
        return;
    }

    log(`Group dropoff #${dropIndex+1} parsed successfully`, { data });
    promptForDropoffLocation(chatId, dropIndex);
};

const promptForDropoffLocation = (chatId, dropIndex) => {
    const state = userState[chatId];
    const stepName = `dropoff_location_${dropIndex}`;
    state.action = 'awaiting_dropoff_location';
    if (state.history[state.history.length - 1] !== stepName) state.history.push(stepName);

    bot.sendMessage(chatId, `*Location for Order #${dropIndex + 1}*`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'go_back' }]],
            keyboard: [[{ text: `Share Drop-off #${dropIndex + 1} Location`, request_location: true }]],
            resize_keyboard: true, one_time_keyboard: true
        }
    });
};

const handleGroupCallbacks = async (chatId, data, msg) => {
    const state = userState[chatId];

    if (data === 'go_back') {
        handleGroupBackButton(chatId, state, msg.message_id);
        return;
    }

    const dropIndex = state.currentDropIndex;

    if (data.startsWith('parcel_size_')) {
        const size = parseInt(data.replace('parcel_size_', ''), 10);
        const sizeMap = {1: 'Small', 2: 'Medium', 3: 'Large', 4: 'Extra Large'};
        state.order.orders[dropIndex].parcel.size = size;
        try{
            await bot.editMessageText(`Parcel size for order #${dropIndex + 1} saved as: ${sizeMap[size]}.`, { chat_id: chatId, message_id: msg.message_id });
        } catch (error) {
            if (!error.response?.body?.description?.includes('message is not modified')) {
                log('Error editing message', error.response?.body || error.message);
            }
        }
        const stepName = `parcel_size_${dropIndex}`;
        if (state.history[state.history.length - 1] !== stepName) state.history.push(stepName);
        promptForParcelContent(chatId, dropIndex);
    } else if (data.startsWith('parcel_content_')) {
        const content = data.replace('parcel_content_', '');
        state.order.orders[dropIndex].parcel.orderContent = content;
        try{
            await bot.editMessageText(`Parcel content for order #${dropIndex + 1} saved as: ${content}.`, { chat_id: chatId, message_id: msg.message_id });
        } catch (error) {
            if (!error.response?.body?.description?.includes('message is not modified')) {
                log('Error editing message', error.response?.body || error.message);
            }
        }
        const stepName = `parcel_content_${dropIndex}`;
        if (state.history[state.history.length - 1] !== stepName) state.history.push(stepName);
        promptToAddAnotherOrFinalize(chatId, dropIndex);
    } else if (data === 'add_another_order') {
        try{
            await bot.editMessageText('Adding another drop-off...', { chat_id: chatId, message_id: msg.message_id });
        } catch (error) {
            if (!error.response?.body?.description?.includes('message is not modified')) {
                log('Error editing message', error.response?.body || error.message);
            }
        }
        state.currentDropIndex++;
        promptForDropoffInput(chatId, state.currentDropIndex);
    } else if (data === 'finalize_group_order') {
        try{
            await bot.editMessageText('All orders added. Please choose a delivery slot.', { chat_id: chatId, message_id: msg.message_id });
        } catch (error) {
            if (!error.response?.body?.description?.includes('message is not modified')) {
                log('Error editing message', error.response?.body || error.message);
            }
        }
        const stepName = `add_another_${dropIndex}`;
        if (state.history[state.history.length - 1] !== stepName) state.history.push(stepName);
        fetchAndShowGroupTimeSlots(chatId);
    } else if (data.startsWith('slot_')) {
        handleGroupSlotSelection(chatId, data, msg.message_id);
    } else if (data === 'confirm_group_order') {
        try{
            await bot.editMessageText('Submitting your group order...', { chat_id: chatId, message_id: msg.message_id, reply_markup: {} });
        } catch (error) {
            if (!error.response?.body?.description?.includes('message is not modified')) {
                log('Error editing message', error.response?.body || error.message);
            }
        }
        submitGroupOrder(chatId);
    }
};

const handleGroupBackButton = (chatId, state, messageId) => {
    if (!state || !state.history || state.history.length <= 1) {
        bot.sendMessage(chatId, "You're at the beginning. You can /start over to cancel.");
        return;
    }

    try{
        if (messageId) bot.deleteMessage(chatId, messageId).catch(console.error);
    } catch (error) {
        if (!error.response?.body?.description?.includes('message to delete not found')) {
            log('Error deleting message', error.response?.body || error.message);
        }
    }
    const currentStep = state.history.pop();
    const previousStep = state.history[state.history.length - 1];
    log(`Back button pressed for group order. From ${currentStep} to ${previousStep}`);

    const [stepType, stepIndexStr] = previousStep.split('_');
    const stepIndex = parseInt(stepIndexStr);

    if (currentStep.startsWith('dropoff_input_') && state.currentDropIndex > 0) {
        state.order.orders.pop();
        state.currentDropIndex--;
    }

    switch(stepType) {
        case 'awaiting':
            startGroupOrder(chatId);
            break;
        case 'pickup':
            promptForPickupLocation(chatId);
            break;
        case 'dropoff':
            if (previousStep.includes('input')) promptForDropoffInput(chatId, stepIndex);
            else if (previousStep.includes('location')) promptForDropoffLocation(chatId, stepIndex);
            break;
        case 'parcel':
            if (previousStep.includes('size')) promptForParcelSize(chatId, stepIndex);
            else if (previousStep.includes('content')) promptForParcelContent(chatId, stepIndex);
            break;
        case 'add':
            promptToAddAnotherOrFinalize(chatId, stepIndex);
            break;
    }
};


const promptForParcelSize = (chatId, dropIndex) => {
    const stepName = `parcel_size_${dropIndex}`;
    const state = userState[chatId];
    if (state.history[state.history.length - 1] !== stepName) state.history.push(stepName);
    bot.sendMessage(chatId, `*Parcel Size for Order #${dropIndex + 1}*`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Small', callback_data: 'parcel_size_1' }, { text: 'Medium', callback_data: 'parcel_size_2' }],
                [{ text: 'Large', callback_data: 'parcel_size_3' }, { text: 'Extra Large', callback_data: 'parcel_size_4' }],
                [{ text: '⬅️ Back', callback_data: 'go_back' }]
            ]
        }
    });
};

const promptForParcelContent = (chatId, dropIndex) => {
    const stepName = `parcel_content_${dropIndex}`;
    const state = userState[chatId];
    if (state.history[state.history.length - 1] !== stepName) state.history.push(stepName);
    bot.sendMessage(chatId, `*Parcel Content for Order #${dropIndex + 1}*`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Food', callback_data: 'parcel_content_Food' }, { text: 'Gifts', callback_data: 'parcel_content_Gifts' }],
                [{ text: 'Documents', callback_data: 'parcel_content_Documents' }, { text: 'Flower', callback_data: 'parcel_content_Flower' }],
                [{ text: 'Personal', callback_data: 'parcel_content_Personal' }, { text: 'Others', callback_data: 'parcel_content_Others' }],
                [{ text: '⬅️ Back', callback_data: 'go_back' }]
            ]
        }
    });
};

const promptToAddAnotherOrFinalize = (chatId, dropIndex) => {
    const stepName = `add_another_${dropIndex}`;
    const state = userState[chatId];
    if (state.history[state.history.length - 1] !== stepName) state.history.push(stepName);
    bot.sendMessage(chatId, `✅ Order #${dropIndex + 1} is complete. What would you like to do next?`, {
        reply_markup: {
            inline_keyboard: [
                [{ text: '➕ Add Another Drop-off', callback_data: 'add_another_order' }],
                [{ text: '✅ Finish & See Price', callback_data: 'finalize_group_order' }],
                [{ text: '⬅️ Back', callback_data: 'go_back' }]
            ]
        }
    });
};

const fetchAndShowGroupTimeSlots = async (chatId) => {
    const userToken = userDB[chatId]?.token;
    if (!userToken) return bot.sendMessage(chatId, "Authentication error. Please /start again.");

    try {
        await bot.sendMessage(chatId, 'Fetching available time slots...');
        const url = 'https://yolpak-api.shinypi.net/order/sameDay-activeTimes';
        const response = await axios.get(url, { headers: { Authorization: `Bearer ${userToken}` } });
        log('API Response from /order/sameDay-activeTimes', response.data);
        if(!response.data.isSuccess) throw new Error(response.data.message || "Failed to fetch slots.");

        const allSlots = response.data.data ? response.data.data.flat() : [];
        if (allSlots.length > 0) {
            const timeSlotButtons = allSlots.map(slot => {
                // Format slot text with proper pickup and delivery times
                let slotText = `Pickup: ${formatDateTime(slot.startDateTime)} - ${formatTime(slot.endDateTime)}`;
                let deliveryStartTime = slot.startDateTime; // Default fallback
                
                if (slot.deliveries && slot.deliveries.length > 0) {
                    const deliverySlot = slot.deliveries[0];
                    deliveryStartTime = deliverySlot.startDateTime;
                    slotText += ` | Drop-off: ${formatDateTime(deliverySlot.startDateTime)} - ${formatTime(deliverySlot.endDateTime)}`;
                }

                return [{
                    text: slotText,
                    callback_data: `slot_${slot.id}|${slot.startDateTime}|${deliveryStartTime}`
                }];
            });
            timeSlotButtons.push([{ text: '⬅️ Back', callback_data: 'go_back' }]);
            try{
                await bot.sendMessage(chatId, 'Please choose a delivery time slot for the entire group order.', {
                    reply_markup: { inline_keyboard: timeSlotButtons },
                });
            } catch (error) {
                 if (!error.response?.body?.description?.includes('message is not modified')) {
                    log('Error editing message', error.response?.body || error.message);
                }
            }
        } else {
            throw new Error('No available time slots found.');
        }
    } catch (error) {
        log('Error fetching time slots', { error: error.message });
        try{
            await bot.sendMessage(chatId, `Sorry, I couldn't fetch the time slots: ${error.message}`);
        } catch (error) {
             if (!error.response?.body?.description?.includes('message is not modified')) {
                log('Error editing message', error.response?.body || error.message);
            }
        }
        delete userState[chatId];
    }
};

const handleGroupSlotSelection = async (chatId, data, messageId) => {
    const state = userState[chatId];
    if (!state || !state.order) return;

    const [, slotId, pickupStart, deliveryStart] = data.split('|');

    // Set the pickup and delivery times correctly from the callback data
    state.order.pickupDateTime = pickupStart;
    state.order.dropOffDateTime = deliveryStart;
    state.order.orderDeliveryType = 'SlotTime';
    
    log('Set pickup and dropoff times from group slot selection', {
        slotId: slotId,
        pickupDateTime: state.order.pickupDateTime,
        dropOffDateTime: state.order.dropOffDateTime
    });

    try{
        await bot.editMessageText(`Time slot selected. Calculating final price...`, { chat_id: chatId, message_id: messageId });
    } catch (error) {
         if (!error.response?.body?.description?.includes('message is not modified')) {
            log('Error editing message', error.response?.body || error.message);
        }
    }
    calculateAndConfirmGroupOrder(chatId);
};

const calculateAndConfirmGroupOrder = async (chatId) => {
    const state = userState[chatId];
    const { order } = state;
    const userToken = userDB[chatId].token;

    try {
        const pricingPayload = {
            sourceLatitude: order.pickupAddress.latitude || 0,
            sourceLongitude: order.pickupAddress.longitude || 0,
            parcels: order.orders.map(o => ({
                weight: parseInt(o.parcel.weight) || 0,
                size: o.parcel.size || 1,
                value: isNaN(o.parcel.value) ? null : parseFloat(o.parcel.value),
                destinationLatitude: o.dropAddress.latitude || 0,
                destinationLongitude: o.dropAddress.longitude || 0
            }))
        };
        log('API Request to /pricing/group-calc-cost', pricingPayload);
        const url = 'https://yolpak-api.shinypi.net/pricing/group-calc-cost';
        const response = await axios.post(url, pricingPayload, { headers: { Authorization: `Bearer ${userToken}` } });
        log('API Response from /pricing/group-calc-cost', response.data);
        if (!response.data.isSuccess) throw new Error(response.data.message || "Failed to calculate price.");

        const priceData = response.data.data;
        const priceSummary = `*Price Summary:*\nPickup: ${priceData.pickupPrice}\nDelivery: ${priceData.deliveryPrice}\n------------------\n*Total: ${priceData.total}*`;

        const sizeMap = { 1: 'Small', 2: 'Medium', 3: 'Large', 4: 'Extra Large' };
        let finalSummary = `*Please confirm your group order:*\n\n---\n*Pickup Details*\n- Name: ${order.pickupAddress.fullName || 'N/A'}\n- Phone: ${order.pickupAddress.phoneNumber || 'N/A'}\n- Address: ${order.pickupAddress.fullAddress || 'N/A'}\n- Location: [View on Map](https://www.google.com/maps?q=${order.pickupAddress.latitude},${order.pickupAddress.longitude})\n- Building: ${order.pickupAddress.buildingNo || 'N/A'}, Floor: ${order.pickupAddress.floor || 'N/A'}, Unit: ${order.pickupAddress.unit || 'N/A'}\n- Postal Code: ${order.pickupAddress.postalCode || 'N/A'}\n- Note: ${order.pickupAddress.note || 'N/A'}\n\n*Delivery Schedule:*\n- Pickup Time: ${formatDateTime(order.pickupDateTime)}\n- Delivery Time: ${formatDateTime(order.dropOffDateTime)}\n\n`;
        order.orders.forEach((o, i) => {
            finalSummary += `---\n*Drop-off & Parcel #${i + 1}*\n- Recipient: ${o.dropAddress.fullName || 'N/A'} (${o.dropAddress.phoneNumber || 'N/A'})\n- Address: ${o.dropAddress.fullAddress || 'N/A'}\n- Location: [View on Map](https://www.google.com/maps?q=${o.dropAddress.latitude},${o.dropAddress.longitude})\n- Building: ${o.dropAddress.buildingNo || 'N/A'}, Floor: ${o.dropAddress.floor || 'N/A'}, Unit: ${o.dropAddress.unit || 'N/A'}\n- Postal Code: ${o.dropAddress.postalCode || 'N/A'}\n- Note: ${o.dropAddress.note || 'N/A'}\n- Parcel: ${o.parcel.weight}g, Size ${sizeMap[o.parcel.size]}, ${o.parcel.orderContent}\n- Parcel Value: ${o.parcel.value || 'N/A'}\n`;
        });

        await bot.sendMessage(chatId, finalSummary + '\n---\n' + priceSummary, { parse_mode: 'Markdown' });
        await bot.sendMessage(chatId, 'Confirm to submit?', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '✅ Confirm Group Order', callback_data: 'confirm_group_order' }],
                    [{ text: '⬅️ Back', callback_data: 'go_back' }, { text: '❌ Cancel', callback_data: 'cancel_order' }]
                ]
            }
        });
    } catch (error) {
        const apiMessage = error.response?.data?.message || 'A critical error occurred.';
        log('Error in calculateAndConfirmGroupOrder', { error: apiMessage });
        await bot.sendMessage(chatId, `An error occurred while calculating the price: ${apiMessage}`);
    }
};


const submitGroupOrder = async (chatId) => {
    const state = userState[chatId];
    if (!state || !state.order) return;
    const { order } = state;
    const userToken = userDB[chatId].token;

    const valueOrNull = (value) => (value === '' || isNaN(value)) ? null : parseFloat(value);

    const finalPayload = {
        pickupDateTime: order.pickupDateTime,
        dropOffDateTime: order.dropOffDateTime,
        orderDeliveryType: "SlotTime",
        isDraft: false,
        pickupAddress: { ...order.pickupAddress },
        orders: order.orders.map(o => ({
            dropAddress: { ...o.dropAddress },
            parcel: {
                weight: parseInt(o.parcel.weight) || 0,
                size: o.parcel.size,
                orderContent: o.parcel.orderContent,
                value: valueOrNull(o.parcel.value),
                pickupFee: null,
                deliverFee: null
            }
        }))
    };
    log('Submitting final group order payload', finalPayload);

    try {
        const url = 'https://yolpak-api.shinypi.net/order/group';
        const response = await axios.post(url, finalPayload, { headers: { Authorization: `Bearer ${userToken}` } });
        log('API Response from /order/group', response.data);
        if (!response.data.isSuccess) throw new Error(response.data.errors ? JSON.stringify(response.data.errors) : (response.data.message || "Failed to submit order."));

        await bot.sendMessage(chatId, '✅ Your group order has been successfully submitted! Thank you.', {
            reply_markup: {
                keyboard: [['Submit New Order'], ['Add Funds', 'Check Balance']], resize_keyboard: true,
            }
        });
        saveOrder(chatId, finalPayload);
    } catch (error) {
        let errorMessage = error.message;

        // Check if this is an API response error with more details
        if (error.response && error.response.data) {
            const apiError = error.response.data;
            log('API Error Response', apiError);

            // Check for specific error messages or balance issues
            if (apiError.message) {
                errorMessage = apiError.message;
            } else if (apiError.errors) {
                if (typeof apiError.errors === 'string') {
                    errorMessage = apiError.errors;
                } else if (Array.isArray(apiError.errors)) {
                    errorMessage = apiError.errors.join(', ');
                } else {
                    errorMessage = JSON.stringify(apiError.errors);
                }
            }

            // Check for balance-related errors specifically
            if (errorMessage.toLowerCase().includes('balance') || 
                errorMessage.toLowerCase().includes('insufficient') ||
                errorMessage.toLowerCase().includes('funds')) {
                errorMessage = `💰 ${errorMessage}\n\nYou can add funds using the 'Add Funds' button in the main menu.`;
            }
        }

        log('Error in submitGroupOrder', { error: errorMessage });
        await bot.sendMessage(chatId, `❌ An error occurred while submitting your group order: ${errorMessage}`);
    } finally {
        delete userState[chatId];
    }
};