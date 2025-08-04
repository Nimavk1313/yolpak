// handlers/auth.js
const axios = require("axios");
const bot = require("../bot");
const { log } = require("../utils/helpers");
const { userState, userDB } = require("../state");
const { saveUserDB } = require("../db/manager");

const initiateLogin = async (chatId, phoneNumber) => {
    log(`Initiating login for ${phoneNumber}`);
    try {
        await bot.sendMessage(chatId, "Sending OTP...", { reply_markup: { remove_keyboard: true } });
        const url = "https://yolpak-api.shinypi.net/auth/login-send-code";
        const response = await axios.post(url, { username: phoneNumber });
        log("API Response from /auth/login-send-code", response.data);
        if (response.data.isSuccess) {
            const otpCode = response.data.data;
            await bot.sendMessage(
                chatId,
                `An OTP has been sent. For testing, the code is: ${otpCode}\n\nPlease enter the OTP.`,
            );
            userState[chatId] = { action: "awaiting_otp", phone: phoneNumber };
        } else {
            await bot.sendMessage(chatId, `Failed to send OTP: ${response.data.message || "Please try again."}`);
        }
    } catch (error) {
        const apiMessage = error.response?.data?.message || "A critical error occurred.";
        log("Error in initiateLogin", { error: apiMessage });
        await bot.sendMessage(chatId, `An error occurred while sending the OTP: ${apiMessage}`);
    }
};

const handleOtp = async (chatId, otp) => {
    const state = userState[chatId];
    if (!state || state.action !== "awaiting_otp") return;
    log(`Handling OTP for ${state.phone}`);
    try {
        await bot.sendMessage(chatId, "Verifying OTP...");
        const url = "https://yolpak-api.shinypi.net/auth/login-check-code";
        const response = await axios.post(url, { username: state.phone, code: otp });
        log("API Response from /auth/login-check-code", response.data);
        if (response.data.isSuccess) {
            userDB[chatId] = { token: response.data.data.token, phone: state.phone };
            saveUserDB();
            delete userState[chatId];
            await bot.sendMessage(chatId, "You have been successfully authenticated!", {
                reply_markup: {
                    keyboard: [
                        ["Submit New Order"],
                        ["Add Funds", "Check Balance"],
                    ],
                    resize_keyboard: true,
                },
            });
        } else {
            await bot.sendMessage(chatId, `Invalid OTP: ${response.data.message || "Please try again."}`);
        }
    } catch (error) {
        const apiMessage = error.response?.data?.message || "A critical error occurred. Perhaps the otp was not correct please try again";
        log("Error in handleOtp", { error: apiMessage });
        await bot.sendMessage(chatId, `An error occurred while verifying the OTP: ${apiMessage}`);
    }
};

module.exports = { initiateLogin, handleOtp };