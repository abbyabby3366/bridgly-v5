package com.example.bridglysms

import android.app.*
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.IBinder
import android.telephony.SmsManager
import androidx.core.app.NotificationCompat
import com.google.gson.Gson
import com.google.gson.JsonObject
import okhttp3.*
import java.util.concurrent.TimeUnit

class SmsService : Service() {

    private lateinit var webSocketClient: OkHttpClient
    private var webSocket: WebSocket? = null
    private val gson = Gson()
    private var serverUrl: String = ""
    private var isRunning = false

    private val sentAction = "com.httpsms.SMS_SENT"
    private val deliveredAction = "com.httpsms.SMS_DELIVERED"

    private val smsManagerService = SmsManagerService()

    companion object {
        private const val CHANNEL_ID = "BridglySmsServiceChannel"
        private const val NOTIFICATION_ID = 1001

        // For UI communication
        var connectionState = "Disconnected"
        var logs = ArrayList<String>()
        var onLogAdded: (() -> Unit)? = null
        var onConnectionStateChanged: (() -> Unit)? = null

        fun addLog(msg: String) {
            android.util.Log.i("BridglySMS", msg)
            logs.add("[${System.currentTimeMillis()}] $msg")
            if (logs.size > 200) logs.removeAt(0)
            onLogAdded?.invoke()
        }

        fun updateState(state: String) {
            connectionState = state
            onConnectionStateChanged?.invoke()
        }
    }

    private val smsSentReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val id = intent.getStringExtra("message_id") ?: return
            val error = when (resultCode) {
                Activity.RESULT_OK -> null
                SmsManager.RESULT_ERROR_GENERIC_FAILURE -> "Generic failure"
                SmsManager.RESULT_ERROR_NO_SERVICE -> "No service"
                SmsManager.RESULT_ERROR_NULL_PDU -> "Null PDU"
                SmsManager.RESULT_ERROR_RADIO_OFF -> "Radio off"
                else -> "Unknown error: $resultCode"
            }

            if (error == null) {
                addLog("SMS sent successfully: $id")
                reportStatus(id, "sent")
            } else {
                addLog("SMS failed to send ($error): $id")
                reportStatus(id, "failed", error)
            }
        }
    }

    private val smsDeliveredReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val id = intent.getStringExtra("message_id") ?: return
            addLog("SMS delivered: $id")
            reportStatus(id, "delivered")
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()

        val filterSent = IntentFilter(sentAction)
        val filterDelivered = IntentFilter(deliveredAction)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(smsSentReceiver, filterSent, RECEIVER_EXPORTED)
            registerReceiver(smsDeliveredReceiver, filterDelivered, RECEIVER_EXPORTED)
        } else {
            registerReceiver(smsSentReceiver, filterSent)
            registerReceiver(smsDeliveredReceiver, filterDelivered)
        }

        webSocketClient = OkHttpClient.Builder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .writeTimeout(10, TimeUnit.SECONDS)
            .connectTimeout(10, TimeUnit.SECONDS)
            .build()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action
        if (action == "STOP") {
            stopForegroundService()
            return START_NOT_STICKY
        }

        serverUrl = intent?.getStringExtra("SERVER_URL") ?: ""
        if (serverUrl.isNotEmpty() && !isRunning) {
            isRunning = true
            startNotification()
            connectWebSocket()
        }

        return START_STICKY
    }

    private fun startNotification() {
        val stopIntent = Intent(this, SmsService::class.java).apply {
            this.action = "STOP"
        }
        val stopPendingIntent = PendingIntent.getService(
            this, 0, stopIntent, PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Bridgly SMS Active")
            .setContentText("Listening for sending commands from $serverUrl")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopPendingIntent)
            .build()

        startForeground(NOTIFICATION_ID, notification)
    }

    private fun stopForegroundService() {
        isRunning = false
        disconnectWebSocket()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun connectWebSocket() {
        if (!isRunning || serverUrl.isEmpty()) return

        addLog("Connecting to WebSocket: $serverUrl")
        updateState("Connecting...")

        val request = Request.Builder()
            .url(serverUrl)
            .build()

        webSocket = webSocketClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                updateState("Connected")
                addLog("WebSocket connection opened successfully.")
                try {
                    val simLogs = smsManagerService.getActiveSubscriptionLogs(this@SmsService)
                    addLog("SIM Info:\n$simLogs")
                } catch (e: Exception) {
                    addLog("Failed to log SIM info: ${e.message}")
                }
                // Send register event
                val registerMsg = JsonObject().apply {
                    addProperty("action", "register")
                    addProperty("isDualSim", SmsManagerService.isDualSIM(this@SmsService))
                }
                webSocket.send(gson.toJson(registerMsg))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val json = gson.fromJson(text, JsonObject::class.java)
                    val action = json.get("action")?.asString ?: ""
                    if (action == "send_sms") {
                        val id = json.get("id")?.asString ?: ""
                        val to = json.get("to")?.asString ?: ""
                        val message = json.get("message")?.asString ?: ""
                        val sim = json.get("sim")?.asInt ?: 1

                        addLog("Received send command. ID: $id, To: $to, SIM: $sim")
                        triggerSend(id, to, message, sim)
                    }
                } catch (e: Exception) {
                    addLog("Error parsing WebSocket message: ${e.message}")
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                updateState("Disconnected")
                addLog("WebSocket closing: $reason ($code)")
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                updateState("Disconnected")
                addLog("WebSocket closed.")
                reconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                updateState("Error: ${t.message}")
                addLog("WebSocket Failure: ${t.message}")
                reconnect()
            }
        })
    }

    private fun reconnect() {
        if (!isRunning) return
        Thread {
            try {
                addLog("Waiting 5s to reconnect...")
                Thread.sleep(5000)
                if (isRunning) {
                    connectWebSocket()
                }
            } catch (e: Exception) {
                // Ignore
            }
        }.start()
    }

    private fun disconnectWebSocket() {
        webSocket?.close(1000, "Service stopped")
        webSocket = null
        updateState("Disconnected")
    }

    private fun triggerSend(id: String, to: String, message: String, simSlot: Int) {
        try {
            val sentIntent = PendingIntent.getBroadcast(
                this,
                id.hashCode() + 1,
                Intent(sentAction).apply {
                    putExtra("message_id", id)
                    setPackage(packageName)
                },
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
            val deliveredIntent = PendingIntent.getBroadcast(
                this,
                id.hashCode() + 2,
                Intent(deliveredAction).apply {
                    putExtra("message_id", id)
                    setPackage(packageName)
                },
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )

            smsManagerService.sendSMS(this, to, message, simSlot, sentIntent, deliveredIntent)
            addLog("SMS triggered via SIM $simSlot: $id")
        } catch (e: Exception) {
            addLog("Error triggering SMS: ${e.message}")
            reportStatus(id, "failed", e.message ?: "Exception in triggerSend")
        }
    }

    private fun reportStatus(id: String, status: String, error: String? = null) {
        val payload = JsonObject().apply {
            addProperty("action", "sms_status")
            addProperty("id", id)
            addProperty("status", status)
            if (error != null) {
                addProperty("error", error)
            }
        }
        Thread {
            webSocket?.send(gson.toJson(payload))
        }.start()
    }

    override fun onDestroy() {
        super.onDestroy()
        unregisterReceiver(smsSentReceiver)
        unregisterReceiver(smsDeliveredReceiver)
        disconnectWebSocket()
    }

    override fun onBind(intent: Intent?): IBinder? {
        return null
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val serviceChannel = NotificationChannel(
                CHANNEL_ID,
                "Bridgly SMS Service Channel",
                NotificationManager.IMPORTANCE_DEFAULT
            )
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(serviceChannel)
        }
    }
}
