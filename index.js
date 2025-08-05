// index.js
require("dotenv").config();
const bot = require("./bot");
const { log, isValidTurkishPhoneNumber } = require("./utils/helpers");
const { userState } = require("./state");
const { loadDatabases } = require("./db/manager");
const { handleStart, handleSubmitNewOrder, handleFundsAndBalance } = require("./handlers/commands");
const { initiateLogin, handleOtp } = require("./handlers/auth");
const singleOrder = require("./handlers/singleOrder");
const groupOrder = require("./handlers/groupOrder");

// --- Initial Setup ---
loadDatabases();
log("Bot server started");

// --- Bot OnText and OnContact Handlers ---
bot.onText(/\/start/, handleStart);
bot.on("contact", async (msg) => initiateLogin(msg.chat.id, msg.contact.phone_number));
bot.onText(/Submit New Order/, handleSubmitNewOrder);
bot.onText(/Add Funds|Check Balance/, handleFundsAndBalance);

// --- Main Message Handler ---
bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text && !msg.location) return;

    log(`Received message from user ${chatId}`, { text: text, location: msg.location });

    const commands = ["/start", "Submit New Order", "Add Funds", "Check Balance"];
    if (msg.contact || (text && commands.some((cmd) => text.startsWith(cmd)))) {
        return;
    }

    const state = userState[chatId];
    if (!state || !state.action) {
        bot.sendMessage(chatId, "I'm not sure what you mean. Please send /start to begin.");
        return;
    }

    let messageHandled = true;
    switch (state.action) {
        case "awaiting_button_press":
            bot.sendMessage(chatId, "Please use one of the buttons provided in the message above to continue.");
            break;
        case "awaiting_phone_input":
            if (isValidTurkishPhoneNumber(text).isValid) initiateLogin(chatId, text);
            else bot.sendMessage(chatId, "This doesn't seem to be a valid Turkish mobile number. Please try again.");
            break;
        case "awaiting_otp":
            handleOtp(chatId, text);
            break;
        case "awaiting_single_order_step":
            if (text === "⬅️ Back") {
                await bot.sendMessage(chatId, "Going back...", { reply_markup: { remove_keyboard: true } });
                singleOrder.handleSingleOrderBackButton(chatId, state);
            } else {
                singleOrder.processSingleOrderStep(chatId, msg);
            }
            break;
        case "awaiting_single_bulk_input":
             singleOrder.processSingleBulkInput(chatId, text);
            break;
            case "awaiting_single_pickup_location":
                if (text === "⬅️ Back") {
                    await bot.sendMessage(chatId, "Going back...", { reply_markup: { remove_keyboard: true } });
                    singleOrder.handleSingleOrderBackButton(chatId, state);
                } else if (msg.location) {
                    state.order.pickupAddress.latitude = msg.location.latitude;
                    state.order.pickupAddress.longitude = msg.location.longitude;
                    await bot.sendMessage(chatId, "✅ Pickup location saved.", { reply_markup: { remove_keyboard: true } });

                    // --- THIS IS THE FIX ---
                    // It now correctly finds the next step, which is 'buildingNo'.
                    const nextStep = singleOrder.findNextSingleOrderStep(state.order, 'pickup_location');
                    singleOrder.askSingleOrderQuestion(chatId, nextStep);

                } else {
                    bot.sendMessage(chatId, "Please use one of the buttons to proceed.");
                }
                break;
            case "awaiting_single_dropoff_location":
                if (text === "⬅️ Back") {
                    await bot.sendMessage(chatId, "Going back...", { reply_markup: { remove_keyboard: true } });
                    singleOrder.handleSingleOrderBackButton(chatId, state);
                } else if (msg.location) {
                    state.order.dropAddress.latitude = msg.location.latitude;
                    state.order.dropAddress.longitude = msg.location.longitude;
                    await bot.sendMessage(chatId, "✅ Drop-off location saved.", { reply_markup: { remove_keyboard: true } });

                    // --- THIS IS THE FIX ---
                    // It now correctly finds the next step, which is 'parcel_weight'.
                    const nextStep = singleOrder.findNextSingleOrderStep(state.order, 'drop_location');
                    singleOrder.askSingleOrderQuestion(chatId, nextStep);

                } else {
                    bot.sendMessage(chatId, "Please use one of the buttons to proceed.");
                }
                break;

        case "awaiting_pickup_bulk_input":
            groupOrder.processPickupBulkInput(chatId, text);
            break;

        case "awaiting_pickup_location":
            if (text === "⬅️ Back") {
                await bot.sendMessage(chatId, "Going back...", { reply_markup: { remove_keyboard: true } });
                groupOrder.handleGroupBackButton(chatId, state);
            } else if (msg.location) {
                state.order.pickupAddress.latitude = msg.location.latitude;
                state.order.pickupAddress.longitude = msg.location.longitude;
                await bot.sendMessage(chatId, "✅ Pickup location saved.", { reply_markup: { remove_keyboard: true } });
                groupOrder.promptForDropoffInput(chatId, state.currentDropIndex);
            } else {
                bot.sendMessage(chatId, "Please use one of the buttons to proceed.");
            }
            break;
        case "awaiting_dropoff_bulk_input":
            groupOrder.processDropoffBulkInput(chatId, text);
            break;
        case "awaiting_dropoff_location":
            if (text === "⬅️ Back") {
                await bot.sendMessage(chatId, "Going back...", { reply_markup: { remove_keyboard: true } });
                groupOrder.handleGroupBackButton(chatId, state);
            } else if (msg.location) {
                const dropIndex = state.currentDropIndex;
                state.order.orders[dropIndex].dropAddress.latitude = msg.location.latitude;
                state.order.orders[dropIndex].dropAddress.longitude = msg.location.longitude;
                await bot.sendMessage(chatId, `✅ Drop-off location for order #${dropIndex + 1} saved.`, { reply_markup: { remove_keyboard: true } });
                groupOrder.promptForParcelSize(chatId, dropIndex);
            } else {
                bot.sendMessage(chatId, "Please use one of the buttons to proceed.");
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

// --- Photo Handler ---
bot.on("photo", async (msg) => {
    const chatId = msg.chat.id;
    const state = userState[chatId];

    if (!state || !state.action) return;

    log(`Received photo from user ${chatId} in state ${state.action}`);

    switch (state.action) {
        case "awaiting_single_order_photo":
            singleOrder.processSinglePicture(chatId, msg);
            break;

        case "awaiting_group_pickup_photo":
            groupOrder.processGroupPickupPicture(chatId, msg);
            break;

        case "awaiting_group_dropoff_photo":
             groupOrder.processGroupDropoffPicture(chatId, msg);
            break;

        default:
            bot.sendMessage(chatId, "I can only process photos when you are creating an order by importing from a picture.");
            break;
    }
});


// --- Callback Query Handler ---
bot.on("callback_query", async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const data = callbackQuery.data;
    const state = userState[chatId];

    log(`Received callback_query from user ${chatId}`, { data });
    bot.answerCallbackQuery(callbackQuery.id);

    if (data.startsWith("order_type_")) {
        try {
            await bot.editMessageText(`You selected: ${data.includes("single") ? "Single Order" : "Group Order"}.`, { chat_id: chatId, message_id: msg.message_id, reply_markup: null });
        } catch (error) {
            if (!error.response?.body?.description?.includes("message is not modified")) {
                log("Error editing message", error.response?.body || error.message);
            }
        }
        if (data.includes("group")) groupOrder.startGroupOrder(chatId);
        else singleOrder.promptForSingleOrderMode(chatId);
        return;
    }

    if (data.startsWith("order_mode_")) {
        const mode = data.split("_")[2];
        const modeText = mode === "stepwise" ? "Step-by-Step" : mode === "bulk" ? "All at Once" : "Import from Picture";
        try {
            await bot.editMessageText(`You selected: ${modeText}.`, { chat_id: chatId, message_id: msg.message_id, reply_markup: null });
        } catch (error) {
            if (!error.response?.body?.description?.includes("message is not modified")) {
                log("Error editing message", error.response?.body || error.message);
            }
        }
        if (mode === "stepwise") singleOrder.startSingleOrder_Stepwise(chatId);
        else if (mode === "bulk") singleOrder.startSingleOrder_Bulk(chatId);
        else if (mode === "picture") singleOrder.startSingleOrder_Picture(chatId);
        return;
    }

    if (data === 'import_pickup_picture_group') {
        try {
            await bot.editMessageText("You chose to import pickup details from a picture.", { chat_id: chatId, message_id: msg.message_id, reply_markup: null });
        } catch (error) {
            if (!error.response?.body?.description?.includes("message is not modified")) {
                log("Error editing message", error.response?.body || error.message);
            }
        }
        groupOrder.startGroupOrder_Picture(chatId);
        return;
    }

    if (data.startsWith('import_dropoff_picture_')) {
        try {
            await bot.editMessageText("You chose to import drop-off details from a picture.", { chat_id: chatId, message_id: msg.message_id, reply_markup: null });
        } catch (error) {
            if (!error.response?.body?.description?.includes("message is not modified")) {
                log("Error editing message", error.response?.body || error.message);
            }
        }
        groupOrder.startGroupDropoffPicture(chatId);
        return;
    }

    if (!state) return;

    if (data === "cancel_order") {
        delete userState[chatId];
        try {
            await bot.editMessageText("Order cancelled.", { chat_id: chatId, message_id: msg.message_id });
        } catch (error) {
            if (!error.response?.body?.description?.includes("message is not modified")) {
                log("Error editing message", error.response?.body || error.message);
            }
        }
        return;
    }

    if (state.orderType === "group") {
        groupOrder.handleGroupCallbacks(chatId, data, msg);
    } else if (state.orderType === "single") {
        singleOrder.handleSingleCallbacks(chatId, data, msg);
    }
});