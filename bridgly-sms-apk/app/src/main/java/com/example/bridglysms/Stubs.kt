package com.example.bridglysms

import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.IBinder

class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
        // Stub
    }
}

class MmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
        // Stub
    }
}

class RespondViaMessageService : Service() {
    override fun onBind(intent: Intent?): IBinder? {
        return null
    }
}
