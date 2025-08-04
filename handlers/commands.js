// handlers/commands.js
const axios = require("axios");
const bot = require("../bot");
const { log } = require("../utils/helpers");
const { userState, userDB } = require("../state");

const handleStart = (msg) => {
    const chatId = msg.chat.id;
    log(`Received /start command from user ${chatId}`);
    delete userState[chatId];
    if (userDB[chatId] && userDB[chatId].token) {
        bot.sendMessage(chatId, "Welcome back! You are already logged in.", {
            reply_markup: {
                keyboard: [
                    ["Submit New Order"],
                    ["Add Funds", "Check Balance"],
                ],
                resize_keyboard: true,
            },
        });
    } else {
        bot.sendMessage(
            chatId,
            "Welcome! Please provide your Turkish phone number to log in (e.g., 05321234567), or use the button below.",
            {
                reply_markup: {
                    keyboard: [
                        [{ text: "Send Phone Number", request_contact: true }],
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true,
                },
            },
        );
        userState[chatId] = { action: "awaiting_phone_input" };
    }
};

const handleSubmitNewOrder = (msg) => {
    const chatId = msg.chat.id;
    log(`Received 'Submit New Order' from user ${chatId}`);
    if (userDB[chatId] && userDB[chatId].token) {
        // Initialize an empty state for the new order
        userState[chatId] = { orderType: null };
        bot.sendMessage(chatId, "What type of order would you like to create?", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "Single Order", callback_data: "order_type_single" }],
                    [{ text: "Group Order", callback_data: "order_type_group" }],
                ],
            },
        });
    } else {
        bot.sendMessage(chatId, "You need to be logged in to submit an order. Please send /start to begin.");
    }
};

const handleFundsAndBalance = async (msg) => {
    const chatId = msg.chat.id;
    log(`Received '${msg.text}' from user ${chatId}`);
    const userToken = userDB[chatId]?.token;
    if (!userToken)
        return bot.sendMessage(chatId, "You need to be logged in. Please send /start.");

    const isAddingFunds = msg.text === "Add Funds";
    const url = isAddingFunds
        ? "https://yolpak-api.shinypi.net/payment/add?amount=1000"
        : "https://yolpak-api.shinypi.net/payment/balance";
    const actionVerb = isAddingFunds ? "adding funds" : "checking balance";

    try {
        await bot.sendMessage(chatId, `Please wait while ${actionVerb}...`);
        const response = await axios.get(url, { headers: { Authorization: `Bearer ${userToken}` } });
        log(`API Response from ${url}`, response.data);
        if (response.data.isSuccess) {
            const message = isAddingFunds
                ? "✅ Successfully added funds! You can check your new balance."
                : `Your current balance is: *${response.data.data}*`;
            await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
        } else {
            await bot.sendMessage(
                chatId,
                `❌ Failed to complete request: ${
                    response.data.message || "An unknown error occurred."
                }`,
            );
        }
    } catch (error) {
        const apiMessage = error.response?.data?.message || "A critical error occurred.";
        log(`Error during ${actionVerb}`, { error: apiMessage });
        await bot.sendMessage(chatId, `❌ An error occurred: ${apiMessage}`);
    }
};

module.exports = { handleStart, handleSubmitNewOrder, handleFundsAndBalance };