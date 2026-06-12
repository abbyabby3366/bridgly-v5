package com.example.bridglysms

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.SmsManager
import android.telephony.SubscriptionManager
import androidx.core.app.ActivityCompat
import java.lang.Exception

class SmsManagerService {

    companion object {
        fun isDualSIM(context: Context): Boolean {
            if (ActivityCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
                return false
            }
            val localSubscriptionManager = getSubscriptionManager(context) ?: return false
            var dualSim = false
            var readSuccessful = false
            try {
                val list = localSubscriptionManager.activeSubscriptionInfoList
                if (list != null) {
                    dualSim = list.size > 1
                    readSuccessful = true
                }
            } catch (e: Exception) {
                // Ignore
            }
            if (!readSuccessful) {
                try {
                    val sharedPref = context.getSharedPreferences("BridglySmsConfig", Context.MODE_PRIVATE)
                    dualSim = sharedPref.getBoolean("is_dual_sim", false)
                } catch (e: Exception) {
                    // Ignore
                }
            }
            return dualSim
        }

        private fun getSubscriptionManager(context: Context): SubscriptionManager? {
            return if (Build.VERSION.SDK_INT < 31) {
                @Suppress("DEPRECATION")
                SubscriptionManager.from(context)
            } else {
                context.getSystemService(SubscriptionManager::class.java)
            }
        }
    }

    fun getActiveSubscriptionLogs(context: Context): String {
        val hasPhoneState = ActivityCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED
        val hasReadSms = ActivityCompat.checkSelfPermission(context, Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED
        val hasSendSms = ActivityCompat.checkSelfPermission(context, Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED
        
        val tm = context.getSystemService(android.telephony.TelephonyManager::class.java)
        val simState = tm.simState
        val phoneCount = if (Build.VERSION.SDK_INT >= 30) tm.activeModemCount else tm.phoneCount
        
        val localSubscriptionManager = getSubscriptionManager(context)
        val defaultSubId = SubscriptionManager.getDefaultSmsSubscriptionId()
        
        var subInfo = ""
        if (localSubscriptionManager != null && hasPhoneState) {
            try {
                val list = localSubscriptionManager.activeSubscriptionInfoList
                subInfo = if (list == null) "null" else "${list.size} subs: " + list.map { "slot=${it.simSlotIndex},subId=${it.subscriptionId}" }.joinToString(",")
            } catch (e: java.lang.Exception) {
                subInfo = "Error: ${e.message}"
            }
        } else {
            subInfo = "No manager or no permission"
        }
        
        var cachedInfo = ""
        try {
            val sharedPref = context.getSharedPreferences("BridglySmsConfig", Context.MODE_PRIVATE)
            val sim1 = sharedPref.getInt("sim1_sub_id", -1)
            val sim2 = sharedPref.getInt("sim2_sub_id", -1)
            val isDual = sharedPref.getBoolean("is_dual_sim", false)
            cachedInfo = " | Cached: sim1=$sim1,sim2=$sim2,isDual=$isDual"
        } catch (e: Exception) {
            // Ignore
        }
        
        return "Permissions: phoneState=$hasPhoneState, readSms=$hasReadSms, sendSms=$hasSendSms | Telephony: simState=$simState, phoneCount=$phoneCount | defaultSubId=$defaultSubId | activeSubs=$subInfo$cachedInfo"
    }

    @Suppress("DEPRECATION")
    @SuppressLint("MissingPermission")
    fun getSmsManager(context: Context, simSlot: Int): SmsManager {
        val localSubscriptionManager = if (Build.VERSION.SDK_INT < 31) {
            SubscriptionManager.from(context)
        } else {
            context.getSystemService(SubscriptionManager::class.java)
        }

        var subscriptionId = SubscriptionManager.getDefaultSmsSubscriptionId()
        var logMsg = "Default SMS SubID: $subscriptionId"
        var listReadSuccessful = false
        try {
            val list = localSubscriptionManager.activeSubscriptionInfoList
            if (list != null && list.isNotEmpty()) {
                listReadSuccessful = true
                if (simSlot == 1 && list.size > 0) {
                    subscriptionId = list[0].subscriptionId
                    logMsg = "SIM 1 selected. SubID: $subscriptionId"
                } else if (simSlot == 2 && list.size > 1) {
                    subscriptionId = list[1].subscriptionId
                    logMsg = "SIM 2 selected. SubID: $subscriptionId"
                } else {
                    logMsg = "SIM slot $simSlot requested but only ${list.size} SIM(s) found. Using default SubID: $subscriptionId"
                }
            } else {
                logMsg = "No active subscriptions found from SubscriptionManager."
            }
        } catch (e: Exception) {
            logMsg = "Error reading active subscriptions (${e.message})."
        }

        if (!listReadSuccessful) {
            try {
                val sharedPref = context.getSharedPreferences("BridglySmsConfig", Context.MODE_PRIVATE)
                val cachedSubId = if (simSlot == 1) {
                    sharedPref.getInt("sim1_sub_id", SubscriptionManager.INVALID_SUBSCRIPTION_ID)
                } else {
                    sharedPref.getInt("sim2_sub_id", SubscriptionManager.INVALID_SUBSCRIPTION_ID)
                }
                
                if (cachedSubId != SubscriptionManager.INVALID_SUBSCRIPTION_ID) {
                    subscriptionId = cachedSubId
                    logMsg += " Using cached SubID for SIM $simSlot: $subscriptionId"
                } else {
                    logMsg += " No cached SubID found for SIM $simSlot. Using default SubID: $subscriptionId"
                }
            } catch (e: Exception) {
                logMsg += " Error reading cached subscriptions: ${e.message}. Using default SubID: $subscriptionId"
            }
        }

        SmsService.addLog(logMsg)

        if (subscriptionId < 0 || subscriptionId == SubscriptionManager.INVALID_SUBSCRIPTION_ID) {
            SmsService.addLog("SubID is invalid ($subscriptionId), returning default SmsManager")
            return if (Build.VERSION.SDK_INT < 31) {
                @Suppress("DEPRECATION")
                SmsManager.getDefault()
            } else {
                context.getSystemService(SmsManager::class.java)
            }
        }

        return if (Build.VERSION.SDK_INT < 31) {
            SmsManager.getSmsManagerForSubscriptionId(subscriptionId)
        } else {
            context.getSystemService(SmsManager::class.java).createForSubscriptionId(subscriptionId)
        }
    }

    fun sendSMS(context: Context, to: String, message: String, simSlot: Int, sentIntent: PendingIntent, deliveredIntent: PendingIntent) {
        val manager = getSmsManager(context, simSlot)
        val parts = manager.divideMessage(message)

        if (parts.size > 1) {
            val sentIntents = ArrayList<PendingIntent>()
            val deliveredIntents = ArrayList<PendingIntent>()
            for (i in 0 until parts.size) {
                // Attach real intents for the last part or all parts depending on how status updates are tracked
                sentIntents.add(sentIntent)
                deliveredIntents.add(deliveredIntent)
            }
            manager.sendMultipartTextMessage(to, null, parts, sentIntents, deliveredIntents)
        } else {
            manager.sendTextMessage(to, null, message, sentIntent, deliveredIntent)
        }
    }
}
