// handlers/groupOrder.js
const axios = require("axios");
const bot = require("../bot");
const ocrService = require("../services/ocrService");
const { userState, userDB } = require("../state");
const { saveOrder } = require("../db/manager");
const { log, isValidTurkishPhoneNumber, isValidWeight, isFourDigitsOrLess, isNumericString, parseTemplate, formatDateTime, formatTime, formatDate } = require("../utils/helpers");

const startGroupOrder = (chatId) => {
    log(`Starting new GROUP order for user ${chatId}`);
    userState[chatId] = {
        action: "awaiting_pickup_bulk_input",
        orderType: "group",
        history: ["start_group_order"],
        order: { isDraft: true, pickupAddress: {}, orders: [] },
        currentDropIndex: 0,
    };
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
    bot.sendMessage(chatId, template, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: "Import Pickup from Picture (OCR)",
                        callback_data: "import_pickup_picture_group",
                    },
                ],
                [{ text: "⬅️ Back", callback_data: "go_back_to_order_type" }]
            ],
            remove_keyboard: true,
        },
    });
};

const startGroupOrder_Picture = (chatId) => {
    log(`Starting new GROUP order (Picture) for user ${chatId}`);
    userState[chatId] = {
        action: "awaiting_group_pickup_photo",
        orderType: "group",
        history: ["start_group_picture"],
        order: { isDraft: true, pickupAddress: {}, orders: [] },
        currentDropIndex: 0,
    };
    bot.sendMessage(chatId, "Please send a picture containing the PICKUP details (Name, Phone, Address, etc.).", {
        reply_markup: {
            inline_keyboard: [[{ text: "⬅️ Back", callback_data: "go_back_group_start" }]],
        },
    });
};

const startGroupDropoffPicture = (chatId) => {
    log(`Starting GROUP drop-off (Picture) for user ${chatId}`);
    const state = userState[chatId];
    state.action = "awaiting_group_dropoff_photo";
    bot.sendMessage(chatId, `Please send a picture containing the details for Drop-off #${state.currentDropIndex + 1}.`, {
        reply_markup: {
            inline_keyboard: [[{ text: "⬅️ Back", callback_data: `go_back_dropoff_input_${state.currentDropIndex}` }]],
        },
    });
};

const validateGroupPickupData = (pickupAddress) => {
    const errors = [];
    const p = pickupAddress;
    if (!p.fullName) errors.push("Pickup Details: 'Sender Name' is a required field.");
    const phoneValidation = isValidTurkishPhoneNumber(p.phoneNumber);
    if (!phoneValidation.isValid) errors.push(`Pickup Details: ${phoneValidation.message}`);
    if (!p.fullAddress) errors.push("Pickup Details: 'Full Address' is required.");
    if (!p.buildingNo || !isFourDigitsOrLess(p.buildingNo)) errors.push("Pickup Details: 'Building No' must be a number with 4 digits or less.");
    if (!p.floor || !isFourDigitsOrLess(p.floor)) errors.push("Pickup Details: 'Floor' must be a number with 4 digits or less.");
    if (!p.unit || !isFourDigitsOrLess(p.unit)) errors.push("Pickup Details: 'Unit' must be a number with 4 digits or less.");
    if (p.postalCode && p.postalCode.toLowerCase() !== "skip" && !isNumericString(p.postalCode)) errors.push("Pickup Details: 'Postal Code' must only contain numbers.");
    return errors;
};

const processGroupPickupPicture = async (chatId, msg) => {
    const state = userState[chatId];
    if (!state) return;

    try {
        await bot.sendMessage(chatId, "Analyzing image for pickup details... 🧠");
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const fileLink = await bot.getFileLink(fileId);
        const response = await axios.get(fileLink, { responseType: "arraybuffer" });
        const imageBuffer = Buffer.from(response.data, "binary");

        const prompt = `
            Extract pickup address details from this image.
            Focus on these key fields: "fullName", "phoneNumber", "fullAddress", "buildingNo", "floor", "unit", "postalCode", "note".
            Return the result as a single, clean JSON object. If a field isn't found, its value should be an empty string.
        `;

        const result = await ocrService.extractDataFromImage(imageBuffer, prompt);

        if (!result.success) {
            throw new Error(result.error);
        }

        const data = result.data;
        log("Extracted data from image for group pickup:", data);

        state.order.pickupAddress = {
            fullName: data.fullName || "",
            phoneNumber: data.phoneNumber || "",
            fullAddress: data.fullAddress || "",
            buildingNo: data.buildingNo || "",
            floor: data.floor || "",
            unit: data.unit || "",
            postalCode: data.postalCode || "",
            note: data.note || "",
        };

        const errors = validateGroupPickupData(state.order.pickupAddress);

        if (errors.length > 0) {
            log("Group picture input for pickup validation failed", { errors });
            let errorMessage = "I read the image, but some pickup information is missing or invalid:\n";
            errorMessage += `- ${errors.join("\n- ")}\n\n`;
            await bot.sendMessage(chatId, errorMessage, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "Upload New Picture", callback_data: "upload_new_picture_group_pickup" }],
                        [{ text: "Enter Details Manually", callback_data: "enter_manually_group_pickup" }]
                    ]
                }
            });
            return;
        }

        log("Group picture input for pickup parsed and validated successfully", state.order.pickupAddress);
        await bot.sendMessage(chatId, "✅ Pickup details extracted successfully!");
        promptForPickupLocation(chatId);

    } catch (error) {
        log("Error processing group pickup picture", { error: error.message });
        await bot.sendMessage(chatId, `❌ I encountered an error reading the image: ${error.message}. Please try again.`);
    }
};

const processPickupBulkInput = (chatId, text) => {
    const state = userState[chatId];
    if (state.history[state.history.length - 1] !== 'awaiting_pickup_bulk_input') {
        state.history.push('awaiting_pickup_bulk_input');
    }
    const data = parseTemplate(text);
    state.order.pickupAddress = { fullName: data["sender name"], phoneNumber: data["sender phone"], fullAddress: data["full address"], buildingNo: data["building no"], floor: data["floor"], unit: data["unit"], postalCode: data["postal code"], note: data["note"],};

    const errors = validateGroupPickupData(state.order.pickupAddress);

    if (errors.length > 0) {
        log("Group pickup input validation failed", { errors });
        bot.sendMessage(chatId, `There were errors with your submission:\n- ${errors.join("\n- ")}\nPlease correct the template and send it again.`);
        return;
    }
    log("Group pickup details parsed successfully", state.order.pickupAddress);
    promptForPickupLocation(chatId);
};

const promptForPickupLocation = (chatId) => {
    const state = userState[chatId];
    state.action = "awaiting_pickup_location";
    if (state.history[state.history.length - 1] !== state.action) {
        state.history.push(state.action);
    }
    bot.sendMessage(chatId, "*Step 2: Pickup Location*", {
        parse_mode: "Markdown",
        reply_markup: {
            keyboard: [[{ text: "Share Pickup Location", request_location: true }], [{ text: "⬅️ Back" }]],
            resize_keyboard: true, one_time_keyboard: true,
        },
    });
};

const promptForDropoffInput = (chatId, dropIndex) => {
    const state = userState[chatId];
    const stepName = `dropoff_input_${dropIndex}`;
    state.action = "awaiting_dropoff_bulk_input";
    state.currentDropIndex = dropIndex;
    if (state.history[state.history.length - 1] !== stepName) {
        state.history.push(stepName);
    }
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
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ text: "Import Drop-off from Picture (OCR)", callback_data: `import_dropoff_picture_${dropIndex}` }],
                [{ text: "⬅️ Back", callback_data: "go_back" }]
            ],
            remove_keyboard: true
        },
    });
    if (!state.order.orders[dropIndex]) {
        state.order.orders[dropIndex] = { dropAddress: {}, parcel: {} };
    }
};

const validateGroupDropoffData = (dropOrder, dropIndex) => {
    const errors = [];
    const d = dropOrder.dropAddress;
    const p = dropOrder.parcel;
    if (!d.fullName) errors.push(`Order #${dropIndex + 1}: 'Recipient Name' is required.`);
    const phoneValidation = isValidTurkishPhoneNumber(d.phoneNumber);
    if (!phoneValidation.isValid) errors.push(`Order #${dropIndex + 1}: ${phoneValidation.message}`);
    if (!d.fullAddress) errors.push(`Order #${dropIndex + 1}: 'Full Address' is required.`);
    if (!d.buildingNo || !isFourDigitsOrLess(d.buildingNo)) errors.push(`Order #${dropIndex + 1}: 'Building No' is invalid, it must be numbers and only less than 4 digits.`);
    if (!d.floor || !isFourDigitsOrLess(d.floor)) errors.push(`Order #${dropIndex + 1}: 'Floor' is invalid, it must be numbers and only less than 4 digits.`);
    if (!d.unit || !isFourDigitsOrLess(d.unit)) errors.push(`Order #${dropIndex + 1}: 'Unit' is invalid, it must be numbers and only less than 4 digits.`);
    if (d.postalCode && d.postalCode.toLowerCase() !== 'skip' && !isNumericString(d.postalCode)) errors.push(`Order #${dropIndex + 1}: 'Postal Code' must be numeric.`);
    const weightValidation = isValidWeight(p.weight);
    if (!weightValidation.isValid) errors.push(`Order #${dropIndex + 1}: ${weightValidation.message}`);
    if (p.value && p.value.toLowerCase() !== 'skip' && !isNumericString(p.value)) errors.push(`Order #${dropIndex + 1}: 'Value' must be a number.`);
    return errors;
};

const processGroupDropoffPicture = async (chatId, msg) => {
    const state = userState[chatId];
    if (!state) return;
    const dropIndex = state.currentDropIndex;

    try {
        await bot.sendMessage(chatId, `Analyzing image for drop-off #${dropIndex + 1} details... 🧠`);
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const fileLink = await bot.getFileLink(fileId);
        const response = await axios.get(fileLink, { responseType: "arraybuffer" });
        const imageBuffer = Buffer.from(response.data, "binary");

        const prompt = `
            Extract drop-off and parcel details from this image.
            Focus on these key fields: "recipientName", "recipientPhone", "recipientFullAddress", "recipientBuildingNo", "recipientFloor", "recipientUnit", "recipientPostalCode", "recipientNote", "parcelWeight", "parcelValue".
            Return the result as a single, clean JSON object. If a field isn't found, its value should be an empty string.
        `;

        const result = await ocrService.extractDataFromImage(imageBuffer, prompt);

        if (!result.success) {
            throw new Error(result.error);
        }

        const data = result.data;
        log(`Extracted data from image for group drop-off #${dropIndex + 1}:`, data);

        const dropOrder = state.order.orders[dropIndex];
        dropOrder.dropAddress = {
            fullName: data.recipientName || "",
            phoneNumber: data.recipientPhone || "",
            fullAddress: data.recipientFullAddress || "",
            buildingNo: data.recipientBuildingNo || "",
            floor: data.recipientFloor || "",
            unit: data.recipientUnit || "",
            postalCode: data.recipientPostalCode || "",
            note: data.recipientNote || "",
        };
        dropOrder.parcel = {
            weight: data.parcelWeight || "",
            value: data.parcelValue || "",
        };

        const errors = validateGroupDropoffData(dropOrder, dropIndex);

        if (errors.length > 0) {
            log(`Group picture input for drop-off #${dropIndex + 1} validation failed`, { errors });
            let errorMessage = `I read the image for drop-off #${dropIndex + 1}, but some information is missing or invalid:\n`;
            errorMessage += `- ${errors.join("\n- ")}\n\n`;
            await bot.sendMessage(chatId, errorMessage, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "Upload New Picture", callback_data: `upload_new_picture_group_dropoff_${dropIndex}` }],
                        [{ text: "Enter Details Manually", callback_data: `enter_manually_group_dropoff_${dropIndex}` }]
                    ]
                }
            });
            return;
        }

        log(`Group picture input for drop-off #${dropIndex + 1} parsed and validated successfully`, dropOrder);
        await bot.sendMessage(chatId, `✅ Drop-off #${dropIndex + 1} details extracted successfully!`);
        promptForDropoffLocation(chatId, dropIndex);

    } catch (error) {
        log(`Error processing group drop-off #${dropIndex + 1} picture`, { error: error.message });
        await bot.sendMessage(chatId, `❌ I encountered an error reading the image for drop-off #${dropIndex + 1}: ${error.message}. Please try again.`);
    }
};

const processDropoffBulkInput = (chatId, text) => {
    const state = userState[chatId];
    const dropIndex = state.currentDropIndex;
    const data = parseTemplate(text);
    const dropOrder = state.order.orders[dropIndex];
    dropOrder.dropAddress = { fullName: data["recipient name"], phoneNumber: data["recipient phone"], fullAddress: data["full address"], buildingNo: data["building no"], floor: data["floor"], unit: data["unit"], postalCode: data["postal code"], note: data["note"], };
    dropOrder.parcel = { weight: data["weight (grams)"], value: data["value"], };

    const errors = validateGroupDropoffData(dropOrder, dropIndex);

    if (errors.length > 0) { log(`Group drop-off #${dropIndex + 1} validation failed`, { errors }); bot.sendMessage(chatId, `There were errors with your submission:\n- ${errors.join("\n- ")}\nPlease correct and resubmit.`); return; }
    log(`Group drop-off #${dropIndex + 1} details parsed successfully`, dropOrder);
    promptForDropoffLocation(chatId, dropIndex);
};

const promptForDropoffLocation = (chatId, dropIndex) => {
    const state = userState[chatId];
    const stepName = `dropoff_location_${dropIndex}`;
    state.action = "awaiting_dropoff_location";
    state.currentDropIndex = dropIndex;
    if (state.history[state.history.length - 1] !== stepName) state.history.push(stepName);
    bot.sendMessage(chatId, `*Location for Order #${dropIndex + 1}*`, {
        parse_mode: "Markdown",
        reply_markup: {
            keyboard: [[{ text: `Share Drop-off #${dropIndex + 1} Location`, request_location: true }], [{ text: "⬅️ Back" }]],
            resize_keyboard: true, one_time_keyboard: true,
        },
    });
};

const handleGroupBackButton = (chatId, state, messageId) => {
    if (!state || !state.history || state.history.length <= 1) {
        bot.sendMessage(chatId, "You're at the beginning. You can /start over to cancel.");
        return;
    }
    try { if (messageId) bot.deleteMessage(chatId, messageId).catch(console.error); } catch (e) { /*...*/ }
    const currentStep = state.history.pop();
    const previousStep = state.history[state.history.length - 1];
    log(`Back button pressed. From ${currentStep} to ${previousStep}`, { history: state.history });
    if (currentStep === 'awaiting_confirmation') {
        delete state.order.pickupDateTime;
        delete state.order.dropOffDateTime;
    }
    const navMap = { 'start_group_order': startGroupOrder, 'awaiting_pickup_location': promptForPickupLocation, 'awaiting_slot_selection': fetchAndShowGroupTimeSlots };
    if (navMap[previousStep]) {
        navMap[previousStep](chatId);
    } else if (previousStep.startsWith('dropoff_input_')) {
        const i = parseInt(previousStep.split("_")[2]);
        promptForDropoffInput(chatId, i);
    } else if (previousStep.startsWith('dropoff_location_')) {
        const i = parseInt(previousStep.split("_")[2]);
        promptForDropoffLocation(chatId, i);
    } else if (previousStep.startsWith('parcel_size_')) {
        const i = parseInt(previousStep.split("_")[2]);
        promptForParcelSize(chatId, i);
    } else if (previousStep.startsWith('parcel_content_')) {
        const i = parseInt(previousStep.split("_")[2]);
        promptForParcelContent(chatId, i);
    } else if (previousStep.startsWith('add_another_')) {
        const i = parseInt(previousStep.split("_")[2]);
        promptToAddAnotherOrFinalize(chatId, i);
    } else {
        startGroupOrder(chatId);
    }
};

const promptForParcelSize = (chatId, dropIndex) => {
    const state = userState[chatId];
    state.action = 'awaiting_button_press';
    const stepName = `parcel_size_${dropIndex}`;
    if (state.history[state.history.length - 1] !== stepName) state.history.push(stepName);
    bot.sendMessage(chatId, `*Parcel Size for Order #${dropIndex + 1}*`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Small", callback_data: "parcel_size_1" }, { text: "Medium", callback_data: "parcel_size_2" }], [{ text: "Large", callback_data: "parcel_size_3" }, { text: "Extra Large", callback_data: "parcel_size_4" }], [{ text: "⬅️ Back", callback_data: "go_back" }]], remove_keyboard: true } });
};

const promptForParcelContent = (chatId, dropIndex) => {
    const state = userState[chatId];
    state.action = 'awaiting_button_press';
    const stepName = `parcel_content_${dropIndex}`;
    if (state.history[state.history.length - 1] !== stepName) state.history.push(stepName);
    bot.sendMessage(chatId, `*Parcel Content for Order #${dropIndex + 1}*`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Food", callback_data: "parcel_content_Food" }, { text: "Gifts", callback_data: "parcel_content_Gifts" }], [{ text: "Documents", callback_data: "parcel_content_Documents" }, { text: "Flower", callback_data: "parcel_content_Flower" }], [{ text: "Personal", callback_data: "parcel_content_Personal" }, { text: "Others", callback_data: "parcel_content_Others" }], [{ text: "⬅️ Back", callback_data: "go_back" }]], remove_keyboard: true } });
};

const promptToAddAnotherOrFinalize = (chatId, dropIndex) => {
    const state = userState[chatId];
    state.action = 'awaiting_button_press';
    const stepName = `add_another_${dropIndex}`;
    if (state.history[state.history.length - 1] !== stepName) state.history.push(stepName);
    bot.sendMessage(chatId, `✅ Order #${dropIndex + 1} is complete. What would you like to do next?`, { reply_markup: { inline_keyboard: [[{ text: "➕ Add Another Drop-off", callback_data: "add_another_order" }], [{ text: "✅ Finish & See Price", callback_data: "finalize_group_order" }], [{ text: "⬅️ Back", callback_data: "go_back" }]], remove_keyboard: true } });
};

const fetchAndShowGroupTimeSlots = async (chatId) => {
    const userToken = userDB[chatId]?.token;
    if (!userToken) return bot.sendMessage(chatId, "Authentication error. Please /start again.");
    try {
        await bot.sendMessage(chatId, "Fetching available time slots...", { reply_markup: { remove_keyboard: true } });
        const url = "https://yolpak-api.shinypi.net/order/sameDay-activeTimes";
        const response = await axios.get(url, { headers: { Authorization: `Bearer ${userToken}` } });
        if (!response.data.isSuccess) { throw new Error(response.data.message || "Failed to fetch slots."); }

        const pickupSlots = response.data.data || [];
        const validSlots = [];
        let messageText = "*Please choose an available time slot for the group order:*\n\n";
        const timeSlotButtons = [];
        let buttonRow = [];

        pickupSlots.forEach(pickupSlot => {
            if (pickupSlot.deliveries && pickupSlot.deliveries.length > 0 && pickupSlot.deliveries[0].startDateTime) {
                const dropOffSlot = pickupSlot.deliveries[0];
                const slotData = {
                    pickupStartTime: pickupSlot.startDateTime,
                    dropOffStartTime: dropOffSlot.startDateTime,
                };
                validSlots.push(slotData);
                const slotIndex = validSlots.length - 1;

                messageText += `*Slot ${slotIndex + 1}:*\n`;
                messageText += `  - Pickup: ${formatDateTime(slotData.pickupStartTime)}\n`;
                messageText += `  - Drop-off: ${formatDateTime(slotData.dropOffStartTime)}\n\n`;

                buttonRow.push({ text: `Slot ${slotIndex + 1}`, callback_data: `choose_slot_${slotIndex}` });
                if (buttonRow.length === 3) {
                    timeSlotButtons.push(buttonRow);
                    buttonRow = [];
                }
            }
        });

        if (buttonRow.length > 0) {
            timeSlotButtons.push(buttonRow);
        }

        if (validSlots.length > 0) {
            userState[chatId].availableSlots = validSlots;
            timeSlotButtons.push([{ text: "⬅️ Back", callback_data: "go_back" }]);
            await bot.sendMessage(chatId, messageText, { 
                parse_mode: "Markdown",
                reply_markup: { inline_keyboard: timeSlotButtons } 
            });
        } else {
            throw new Error("No available time slots with valid drop-off times were found.");
        }
    } catch (error) {
        log("Error fetching time slots", { error: error.message });
        await bot.sendMessage(chatId, `Sorry, I couldn't fetch the time slots: ${error.message}`, {
            reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "go_back" }]] },
        });
    }
};

const handleGroupCallbacks = async (chatId, data, msg) => {
    const state = userState[chatId];
    if (data === "go_back") {
        handleGroupBackButton(chatId, state, msg.message_id);
        return;
    } else if (data === 'go_back_to_order_type' || data === 'go_back_group_start') {
        // This is a simplified back button for the initial OCR choice
        const { handleStart } = require('../handlers/commands'); // A bit of a circular dependency, but ok for this
        handleStart({ chat: { id: chatId } }); // Go back to the very beginning
        return;
    } else if (data.startsWith('upload_new_picture_group_pickup')) {
        startGroupOrder_Picture(chatId);
        return;
    } else if (data.startsWith('enter_manually_group_pickup')) {
        startGroupOrder(chatId);
        return;
    } else if (data.startsWith('upload_new_picture_group_dropoff_')) {
        const dropIndex = parseInt(data.split('_').pop(), 10);
        startGroupDropoffPicture(chatId, dropIndex);
        return;
    } else if (data.startsWith('enter_manually_group_dropoff_')) {
        const dropIndex = parseInt(data.split('_').pop(), 10);
        promptForDropoffInput(chatId, dropIndex);
        return;
    } else if (data.startsWith(`go_back_dropoff_input_`)) {
        const dropIndex = parseInt(data.split('_').pop(), 10);
        promptForDropoffInput(chatId, dropIndex);
        return;
    }

    const dropIndex = state.currentDropIndex;
    if (data.startsWith("parcel_size_")) {
        state.order.orders[dropIndex].parcel.size = parseInt(data.replace("parcel_size_", ""), 10);
        try { await bot.editMessageText(`Parcel size saved.`, { chat_id: chatId, message_id: msg.message_id }); } catch (e) { /*...*/ }
        promptForParcelContent(chatId, dropIndex);
    } else if (data.startsWith("parcel_content_")) {
        state.order.orders[dropIndex].parcel.orderContent = data.replace("parcel_content_", "");
        try { await bot.editMessageText(`Parcel content saved.`, { chat_id: chatId, message_id: msg.message_id }); } catch (e) { /*...*/ }
        promptToAddAnotherOrFinalize(chatId, dropIndex);
    } else if (data === "add_another_order") {
        try { await bot.editMessageText("Adding another drop-off...", { chat_id: chatId, message_id: msg.message_id }); } catch (e) { /*...*/ }
        state.currentDropIndex++;
        promptForDropoffInput(chatId, state.currentDropIndex);
    } else if (data === "finalize_group_order") {
        state.action = 'awaiting_button_press';
        if (state.history[state.history.length - 1] !== 'awaiting_slot_selection') {
            state.history.push('awaiting_slot_selection');
        }
        try { await bot.editMessageText("Please choose a delivery slot.", { chat_id: chatId, message_id: msg.message_id }); } catch (e) { /*...*/ }
        fetchAndShowGroupTimeSlots(chatId);
    } else if (data.startsWith("choose_slot_")) {
        const slotIndex = parseInt(data.replace("choose_slot_", ""), 10);
        const selectedSlot = state.availableSlots[slotIndex];

        if (selectedSlot) {
            state.order.pickupDateTime = selectedSlot.pickupStartTime;
            state.order.dropOffDateTime = selectedSlot.dropOffStartTime;
            state.order.orderDeliveryType = "SlotTime";
            delete state.availableSlots; // Clean up

            if (state.history[state.history.length - 1] !== 'awaiting_confirmation') {
                state.history.push('awaiting_confirmation');
            }
            log("Set times from selection", { pickup: state.order.pickupDateTime, dropoff: state.order.dropOffDateTime });
            try { await bot.editMessageText(`Time slot selected. Calculating final price...`, { chat_id: chatId, message_id: msg.message_id }); } catch (e) { /*...*/ }
            calculateAndConfirmGroupOrder(chatId);
        } else {
            log("Error: Invalid slot index chosen.", { data });
            bot.sendMessage(chatId, "Sorry, that was an invalid slot. Please try again.");
        }
    } else if (data === "confirm_group_order") {
        try { await bot.editMessageText("Submitting your group order...", { chat_id: chatId, message_id: msg.message_id, reply_markup: {} }); } catch (e) { /*...*/ }
        submitGroupOrder(chatId);
    }
};
// REPLACE the existing calculateAndConfirmGroupOrder function with this one

const calculateAndConfirmGroupOrder = async (chatId) => {
    const state = userState[chatId];
    state.action = 'awaiting_button_press';
    const { order } = state;
    const userToken = userDB[chatId].token;
    try {
        const pricingPayload = {
            sourceLatitude: order.pickupAddress.latitude || 0,
            sourceLongitude: order.pickupAddress.longitude || 0,
            parcels: order.orders.map((o) => ({ weight: parseInt(o.parcel.weight) || 0, size: o.parcel.size || 1, value: isNaN(o.parcel.value) ? null : parseFloat(o.parcel.value), destinationLatitude: o.dropAddress.latitude || 0, destinationLongitude: o.dropAddress.longitude || 0 })),
        };
        const url = "https://yolpak-api.shinypi.net/pricing/group-calc-cost";
        const response = await axios.post(url, pricingPayload, { headers: { Authorization: `Bearer ${userToken}` } });
        if (!response.data.isSuccess) throw new Error(response.data.message || "Failed to calculate price.");

        const priceData = response.data.data;
        const priceSummary = `*Price Summary:*\n- Pickup: ${priceData.pickupPrice}\n- Delivery: ${priceData.deliveryPrice}\n------------------\n*Total: ${priceData.total}*`;
        const sizeMap = { 1: "Small", 2: "Medium", 3: "Large", 4: "Extra Large" };

        let finalSummary = `*Please confirm your group order:*\n\n`;

        // Pickup Details Structure
        finalSummary += `*Pickup Details*\n`;
        finalSummary += `- Name: ${order.pickupAddress.fullName || "N/A"}\n`;
        finalSummary += `- Phone: ${order.pickupAddress.phoneNumber || "N/A"}\n`;
        finalSummary += `- Address: ${order.pickupAddress.fullAddress || "N/A"}\n`;
        if (order.pickupAddress.latitude && order.pickupAddress.longitude) { finalSummary += `- Location: [View on Map](https://www.google.com/maps?q=${order.pickupAddress.latitude},${order.pickupAddress.longitude})\n`; }
        finalSummary += `- Building/Floor/Unit: ${order.pickupAddress.buildingNo || "N/A"} / ${order.pickupAddress.floor || "N/A"} / ${order.pickupAddress.unit || "N/A"}\n`;
        finalSummary += `- Postal Code: ${order.pickupAddress.postalCode || "N/A"}\n`;
        finalSummary += `- Note: ${order.pickupAddress.note || "N/A"}\n\n`;

        finalSummary += `*Delivery Schedule*\n- Pickup Time: ${formatDateTime(order.pickupDateTime)}\n- Delivery Time: ${formatDateTime(order.dropOffDateTime)}\n\n`;

        // Drop-off and Parcel Details Loop
        order.orders.forEach((o, i) => {
            const d = o.dropAddress; 
            const p = o.parcel;

            // CORRECTED: Drop-off Details Structure now mirrors Pickup Details
            finalSummary += `*--- Drop-off Details #${i + 1} ---*\n`;
            finalSummary += `- Name: ${d.fullName || "N/A"}\n`;
            finalSummary += `- Phone: ${d.phoneNumber || "N/A"}\n`;
            finalSummary += `- Address: ${d.fullAddress || "N/A"}\n`;
            if (d.latitude && d.longitude) { finalSummary += `- Location: [View on Map](https://www.google.com/maps?q=${d.latitude},${d.longitude})\n`; }
            finalSummary += `- Building/Floor/Unit: ${d.buildingNo || "N/A"} / ${d.floor || "N/A"} / ${d.unit || "N/A"}\n`;
            finalSummary += `- Postal Code: ${d.postalCode || "N/A"}\n`;
            finalSummary += `- Note: ${d.note || "N/A"}\n\n`;

            finalSummary += `*Parcel Details #${i + 1}*\n`;
            finalSummary += `- Content: ${p.orderContent || 'N/A'}\n`;
            finalSummary += `- Weight: ${p.weight || 'N/A'}g, Size: ${sizeMap[p.size] || 'N/A'}\n`;
            finalSummary += `- Value: ${p.value || "N/A"}\n\n`;
        });

        await bot.sendMessage(chatId, finalSummary + "\n" + priceSummary, { parse_mode: "Markdown", disable_web_page_preview: true, reply_markup: { remove_keyboard: true } });
        await bot.sendMessage(chatId, "Confirm to submit?", {
            reply_markup: { 
                inline_keyboard: [
                    [{ text: "✅ Confirm Group Order", callback_data: "confirm_group_order" }],
                    [{ text: "⬅️ Back", callback_data: "go_back" }, { text: "❌ Cancel", callback_data: "cancel_order" }]
                ]
            },
        });
    } catch (error) {
        log("Error calculating group order price", { error: error.message });
        await bot.sendMessage(chatId, `❌ An error occurred while calculating the price: ${error.message}`, {
            reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "go_back" }]] },
        });
    }
};

const submitGroupOrder = async (chatId) => {
    const state = userState[chatId];
    if (!state || !state.order) return;
    const { order } = state;
    const userToken = userDB[chatId].token;
    const valueOrNull = (value) => (value === "" || !value || isNaN(value) ? null : parseFloat(value));
    const finalPayload = {
        pickupDateTime: order.pickupDateTime,
        dropOffDateTime: order.dropOffDateTime,
        orderDeliveryType: "SlotTime",
        isDraft: false,
        pickupAddress: { ...order.pickupAddress },
        orders: order.orders.map((o) => ({
            dropAddress: { ...o.dropAddress },
            parcel: {
                weight: parseInt(o.parcel.weight) || 0,
                size: o.parcel.size,
                orderContent: o.parcel.orderContent,
                value: valueOrNull(o.parcel.value),
            },
        })),
    };
    log("Submitting final group order payload", finalPayload);
    try {
        const url = "https://yolpak-api.shinypi.net/order/group";
        const response = await axios.post(url, finalPayload, { headers: { Authorization: `Bearer ${userToken}` } });
        if (!response.data.isSuccess) {
            throw new Error(response.data.Message || response.data.message || "Failed to submit order.");
        }
        await bot.sendMessage(chatId, "✅ Your group order has been successfully submitted! Thank you.", { reply_markup: { keyboard: [["Submit New Order"], ["Add Funds", "Check Balance"]], resize_keyboard: true } });
        saveOrder(chatId, finalPayload);
    } catch (error) {
        let errorMessage = error.message;
        if (error.response) {
            const apiError = error.response.data;
            log("API Error Response", apiError);
            errorMessage = apiError.Message || apiError.message || `Request failed with status code ${error.response.status}`;
        }
        log("Error in submitGroupOrder", { error: errorMessage });
        await bot.sendMessage(chatId, `❌ An error occurred while submitting your group order:\n\n*Server message:*\n_${errorMessage}_`, {
            parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "go_back" }]] },
        });
    } finally {
        delete userState[chatId];
    }
};

module.exports = {
    startGroupOrder, processPickupBulkInput, promptForDropoffInput, processDropoffBulkInput,
    handleGroupCallbacks, handleGroupBackButton, promptForPickupLocation, promptForParcelSize,
    promptForParcelContent, calculateAndConfirmGroupOrder, submitGroupOrder, promptToAddAnotherOrFinalize,
    fetchAndShowGroupTimeSlots,
    startGroupOrder_Picture,
    processGroupPickupPicture,
    startGroupDropoffPicture,
    processGroupDropoffPicture,
};