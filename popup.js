// === API Key Manager Class ===
class APIKeyManager {
  static async getAPIKey() {
    const result = await chrome.storage.sync.get(['groqAPIKey']);
    return result.groqAPIKey || null;
  }

  static async setAPIKey(apiKey) {
    await chrome.storage.sync.set({ groqAPIKey: apiKey });
  }

  static async hasAPIKey() {
    const apiKey = await this.getAPIKey();
    return apiKey && apiKey.trim().length > 0;
  }

  static async clearAPIKey() {
    await chrome.storage.sync.remove(['groqAPIKey']);
  }
}

// === Enhanced API Key Validation ===
function isValidGroqAPIKey(apiKey) {
  return apiKey.startsWith("gsk_") && apiKey.length >= 40;
}

// === API Key Validation Test ===
async function validateAPIKey(apiKey) {
  try {
    const response = await fetch("https://api.groq.com/openai/v1/models", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      }
    });
    return response.ok;
  } catch (error) {
    console.error("API key validation error:", error);
    return false;
  }
}

// === Status Display Function ===
function showStatus(message, type) {
  const statusDiv = document.getElementById("apiStatus");
  statusDiv.className = `status status-${type}`;
  statusDiv.textContent = message;
  
  if (type === 'success') {
    setTimeout(() => {
      statusDiv.className = '';
      statusDiv.textContent = '';
    }, 3000);
  }
}

// === Update API Key Status ===
async function updateAPIKeyStatus() {
  const statusDiv = document.getElementById("apiStatus");
  const hasKey = await APIKeyManager.hasAPIKey();
  
  if (hasKey) {
    statusDiv.className = "status status-success";
    statusDiv.textContent = "API Key is configured";
  } else {
    statusDiv.className = "status status-error";
    statusDiv.textContent = "No API Key configured";
  }
}

// === Save API Key Function ===
async function saveAPIKey() {
  const apiKeyInput = document.getElementById("apiKeyInput");
  const apiKey = apiKeyInput.value.trim();
  
  if (!apiKey) {
    showStatus("Please enter an API key", "error");
    return;
  }
  
  if (!isValidGroqAPIKey(apiKey)) {
    showStatus("Invalid Groq API key format. API keys should start with 'gsk_' and be 40+ characters", "error");
    return;
  }
  
  try {
    const isValid = await validateAPIKey(apiKey);
    
    if (isValid) {
      await APIKeyManager.setAPIKey(apiKey);
      apiKeyInput.value = "";
      await updateAPIKeyStatus();
      showStatus("API key saved successfully!", "success");
    } else {
      showStatus("Invalid API key. Please check your Groq API key.", "error");
    }
  } catch (error) {
    showStatus("Failed to validate API key: " + error.message, "error");
  }
}

// === Clear API Key Function ===
async function clearAPIKey() {
  try {
    await APIKeyManager.clearAPIKey();
    await updateAPIKeyStatus();
    showStatus("API key cleared successfully!", "success");
  } catch (error) {
    showStatus("Failed to clear API key: " + error.message, "error");
  }
}

// === DOM Content Loaded Event Listener ===
document.addEventListener('DOMContentLoaded', async function() {
  // Initialize API key status
  await updateAPIKeyStatus();
  
  // Event listeners for buttons
  document.getElementById('btnSaveKey').addEventListener('click', saveAPIKey);
  document.getElementById('btnClearKey').addEventListener('click', clearAPIKey);
  
  // Enter key support for API key input
  document.getElementById('apiKeyInput').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
      saveAPIKey();
    }
  });
});