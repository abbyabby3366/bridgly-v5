package com.example.bridglysms

import android.Manifest
import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.telephony.SmsManager
import android.telephony.SubscriptionManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat

class MainActivity : ComponentActivity() {

    private val requiredPermissions = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        arrayOf(
            Manifest.permission.SEND_SMS,
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.READ_SMS,
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.POST_NOTIFICATIONS,
            Manifest.permission.ACCESS_FINE_LOCATION
        )
    } else {
        arrayOf(
            Manifest.permission.SEND_SMS,
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.READ_SMS,
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.ACCESS_FINE_LOCATION
        )
    }

    private val directSmsSentReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val error = when (resultCode) {
                Activity.RESULT_OK -> null
                SmsManager.RESULT_ERROR_GENERIC_FAILURE -> "Generic failure"
                SmsManager.RESULT_ERROR_NO_SERVICE -> "No service"
                SmsManager.RESULT_ERROR_NULL_PDU -> "Null PDU"
                SmsManager.RESULT_ERROR_RADIO_OFF -> "Radio off"
                else -> "Unknown error: $resultCode"
            }
            if (error == null) {
                SmsService.addLog("Direct SMS sent successfully")
            } else {
                SmsService.addLog("Direct SMS failed to send ($error)")
            }
        }
    }

    private val directSmsDeliveredReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            SmsService.addLog("Direct SMS delivered")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        val filterSent = IntentFilter("com.httpsms.DIRECT_SMS_SENT")
        val filterDelivered = IntentFilter("com.httpsms.DIRECT_SMS_DELIVERED")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(directSmsSentReceiver, filterSent, RECEIVER_EXPORTED)
            registerReceiver(directSmsDeliveredReceiver, filterDelivered, RECEIVER_EXPORTED)
        } else {
            registerReceiver(directSmsSentReceiver, filterSent)
            registerReceiver(directSmsDeliveredReceiver, filterDelivered)
        }

        val sharedPref = getSharedPreferences("BridglySmsConfig", Context.MODE_PRIVATE)
        val initialUrl = sharedPref.getString("server_url", "wss://bridgly.neuron.my") ?: "wss://bridgly.neuron.my"

        if (hasAllPermissions()) {
            saveSubscriptionIds()
            val intent = Intent(this, SmsService::class.java).apply {
                putExtra("SERVER_URL", initialUrl)
            }
            ContextCompat.startForegroundService(this, intent)
        }

        setContent {
            MaterialTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    SmsGatewayDashboard(
                        initialUrl = initialUrl,
                        onSaveUrl = { url ->
                            sharedPref.edit().putString("server_url", url).apply()
                        },
                        onStartService = { url ->
                            saveSubscriptionIds()
                            val intent = Intent(this, SmsService::class.java).apply {
                                putExtra("SERVER_URL", url)
                            }
                            ContextCompat.startForegroundService(this, intent)
                        },
                        onStopService = {
                            val intent = Intent(this, SmsService::class.java).apply {
                                action = "STOP"
                            }
                            startService(intent)
                        },
                        checkPermissions = { hasAllPermissions() },
                        requestPermissionsLauncher = { launcher ->
                            launcher.launch(requiredPermissions)
                        }
                    )
                }
            }
        }
    }

    private fun hasAllPermissions(): Boolean {
        return requiredPermissions.all {
            ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
        }
    }

    fun saveSubscriptionIds() {
        val localSubscriptionManager = if (Build.VERSION.SDK_INT < 31) {
            SubscriptionManager.from(this)
        } else {
            getSystemService(SubscriptionManager::class.java)
        }
        
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
            try {
                val list = localSubscriptionManager.activeSubscriptionInfoList
                val sharedPref = getSharedPreferences("BridglySmsConfig", Context.MODE_PRIVATE)
                val editor = sharedPref.edit()
                if (list != null && list.isNotEmpty()) {
                    editor.putBoolean("is_dual_sim", list.size > 1)
                    if (list.size > 0) {
                        editor.putInt("sim1_sub_id", list[0].subscriptionId)
                        android.util.Log.i("BridglySMS", "Saved sim1_sub_id: ${list[0].subscriptionId}")
                    } else {
                        editor.remove("sim1_sub_id")
                    }
                    if (list.size > 1) {
                        editor.putInt("sim2_sub_id", list[1].subscriptionId)
                        android.util.Log.i("BridglySMS", "Saved sim2_sub_id: ${list[1].subscriptionId}")
                    } else {
                        editor.remove("sim2_sub_id")
                    }
                } else {
                    editor.putBoolean("is_dual_sim", false)
                    editor.remove("sim1_sub_id")
                    editor.remove("sim2_sub_id")
                    android.util.Log.i("BridglySMS", "No active subscriptions found when saving")
                }
                editor.apply()
            } catch (e: Exception) {
                android.util.Log.e("BridglySMS", "Failed to save subscription IDs: ${e.message}")
            }
        } else {
            android.util.Log.i("BridglySMS", "Permissions not granted when saving subscription IDs")
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        try {
            unregisterReceiver(directSmsSentReceiver)
            unregisterReceiver(directSmsDeliveredReceiver)
        } catch (e: Exception) {
            // Ignore
        }
    }
}

@Composable
fun SmsGatewayDashboard(
    initialUrl: String,
    onSaveUrl: (String) -> Unit,
    onStartService: (String) -> Unit,
    onStopService: () -> Unit,
    checkPermissions: () -> Boolean,
    requestPermissionsLauncher: (ActivityResultLauncherWrapper) -> Unit
) {
    var serverUrl by remember { mutableStateOf(initialUrl) }
    var connectionState by remember { mutableStateOf(SmsService.connectionState) }
    val logs = remember { mutableStateListOf<String>().apply { addAll(SmsService.logs) } }
    var permissionsGranted by remember { mutableStateOf(checkPermissions()) }

    // Direct Sender States
    var directTo by remember { mutableStateOf("") }
    var directMessage by remember { mutableStateOf("") }
    var directSim by remember { mutableStateOf(1) }

    val listState = androidx.compose.foundation.lazy.rememberLazyListState()
    val scrollState = rememberScrollState()

    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        permissionsGranted = results.values.all { it }
        if (permissionsGranted) {
            onStartService(serverUrl)
        }
    }

    LaunchedEffect(Unit) {
        SmsService.onConnectionStateChanged = {
            connectionState = SmsService.connectionState
        }
        SmsService.onLogAdded = {
            logs.clear()
            logs.addAll(SmsService.logs)
        }
    }

    LaunchedEffect(logs.size) {
        if (logs.isNotEmpty()) {
            listState.animateScrollToItem(logs.size - 1)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .systemBarsPadding()
            .padding(16.dp),
        verticalArrangement = Arrangement.Top,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            text = "Bridgly SMS Gateway",
            fontSize = 24.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(bottom = 12.dp)
        )

        // Top Scrollable Cards Area
        Column(
            modifier = Modifier
                .weight(1.3f)
                .fillMaxWidth()
                .verticalScroll(scrollState)
        ) {
            // Permission Card
            Card(
                modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
                shape = RoundedCornerShape(8.dp)
            ) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Text(
                        text = if (permissionsGranted) "✅ All Permissions Granted" else "⚠️ Permissions Required",
                        fontWeight = FontWeight.SemiBold,
                        color = if (permissionsGranted) Color(0xFF2E7D32) else Color(0xFFD32F2F)
                    )
                    Text(
                        text = "Requires Send/Read/Receive SMS, Read SIM slots, and notifications permissions.",
                        fontSize = 12.sp,
                        color = Color.Gray,
                        modifier = Modifier.padding(vertical = 4.dp)
                    )
                    if (!permissionsGranted) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Button(
                                onClick = {
                                    requestPermissionsLauncher(ActivityResultLauncherWrapper {
                                        permissionLauncher.launch(it)
                                    })
                                },
                                modifier = Modifier.weight(1f)
                            ) {
                                Text("Request")
                            }

                            val context = LocalContext.current
                            Button(
                                onClick = {
                                    try {
                                        val intent = Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                                            data = android.net.Uri.fromParts("package", context.packageName, null)
                                        }
                                        context.startActivity(intent)
                                    } catch (e: Exception) {
                                        Toast.makeText(context, "Could not open settings", Toast.LENGTH_SHORT).show()
                                    }
                                },
                                modifier = Modifier.weight(1f),
                                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.secondary)
                            ) {
                                Text("Settings")
                            }
                        }
                    } else {
                        val context = LocalContext.current
                        OutlinedButton(
                            onClick = {
                                try {
                                    val intent = Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                                        data = android.net.Uri.fromParts("package", context.packageName, null)
                                    }
                                    context.startActivity(intent)
                                } catch (e: Exception) {
                                    Toast.makeText(context, "Could not open settings", Toast.LENGTH_SHORT).show()
                                }
                            },
                            modifier = Modifier.fillMaxWidth().padding(top = 8.dp)
                        ) {
                            Text("Configure App Permissions")
                        }
                    }
                }
            }

            // Server Config Card
            Card(
                modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
                shape = RoundedCornerShape(8.dp)
            ) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Text(text = "WebSocket Server Configuration", fontWeight = FontWeight.SemiBold)
                    Spacer(modifier = Modifier.height(4.dp))
                    OutlinedTextField(
                        value = serverUrl,
                        onValueChange = {
                            serverUrl = it
                            onSaveUrl(it)
                        },
                        label = { Text("Server WS URL") },
                        placeholder = { Text("wss://bridgly.neuron.my") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Button(
                            onClick = {
                                if (!permissionsGranted) {
                                    permissionsGranted = checkPermissions()
                                }
                                if (permissionsGranted) {
                                    onStartService(serverUrl)
                                } else {
                                    SmsService.addLog("Cannot start service: missing permissions.")
                                }
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2E7D32)),
                            modifier = Modifier.weight(1f).padding(end = 4.dp)
                        ) {
                            Text("Connect", color = Color.White)
                        }

                        Button(
                            onClick = { onStopService() },
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFD32F2F)),
                            modifier = Modifier.weight(1f).padding(start = 4.dp)
                        ) {
                            Text("Disconnect", color = Color.White)
                        }
                    }
                }
            }

            // Direct SMS Card
            Card(
                modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
                shape = RoundedCornerShape(8.dp)
            ) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Text(text = "Direct SMS Sender (No Server)", fontWeight = FontWeight.SemiBold)
                    Spacer(modifier = Modifier.height(4.dp))
                    OutlinedTextField(
                        value = directTo,
                        onValueChange = { directTo = it },
                        label = { Text("Recipient Number") },
                        placeholder = { Text("+1234567890") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    OutlinedTextField(
                        value = directMessage,
                        onValueChange = { directMessage = it },
                        label = { Text("Message Body") },
                        placeholder = { Text("Hello direct!") },
                        modifier = Modifier.fillMaxWidth(),
                        maxLines = 3
                    )
                    Spacer(modifier = Modifier.height(6.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = directSim == 1, onClick = { directSim = 1 })
                            Text("SIM 1", fontSize = 14.sp)
                            Spacer(modifier = Modifier.width(12.dp))
                            RadioButton(selected = directSim == 2, onClick = { directSim = 2 })
                            Text("SIM 2", fontSize = 14.sp)
                        }

                        val context = LocalContext.current
                        Button(
                            onClick = {
                                if (!permissionsGranted) {
                                    Toast.makeText(context, "Please grant SMS and Phone permissions first!", Toast.LENGTH_LONG).show()
                                    return@Button
                                }
                                if (directTo.isEmpty() || directMessage.isEmpty()) {
                                    Toast.makeText(context, "Fill in number and message!", Toast.LENGTH_SHORT).show()
                                    return@Button
                                }
                                try {
                                    val id = java.util.UUID.randomUUID().toString()
                                    val sentIntent = PendingIntent.getBroadcast(
                                        context,
                                        id.hashCode() + 3,
                                        Intent("com.httpsms.DIRECT_SMS_SENT").apply {
                                            putExtra("message_id", id)
                                            setPackage(context.packageName)
                                        },
                                        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                                    )
                                    val deliveredIntent = PendingIntent.getBroadcast(
                                        context,
                                        id.hashCode() + 4,
                                        Intent("com.httpsms.DIRECT_SMS_DELIVERED").apply {
                                            putExtra("message_id", id)
                                            setPackage(context.packageName)
                                        },
                                        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                                    )
                                    (context as? MainActivity)?.saveSubscriptionIds()
                                    val smsManagerService = SmsManagerService()
                                    smsManagerService.sendSMS(context, directTo, directMessage, directSim, sentIntent, deliveredIntent)
                                    SmsService.addLog("Direct SMS sent to $directTo via SIM $directSim")
                                    directMessage = "" // Clear message body
                                } catch (e: Exception) {
                                    SmsService.addLog("Direct SMS failed: ${e.message}")
                                    Toast.makeText(context, "Failed: ${e.message}", Toast.LENGTH_LONG).show()
                                }
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary)
                        ) {
                            Text("Send Direct")
                        }
                    }
                }
            }
        }

        // Fixed Bottom area
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(text = "Status:", fontWeight = FontWeight.Bold)
            val color = when {
                connectionState.startsWith("Connected") -> Color(0xFF2E7D32)
                connectionState.startsWith("Connecting") -> Color(0xFFF57C00)
                else -> Color(0xFFD32F2F)
            }
            Text(
                text = connectionState,
                color = color,
                fontWeight = FontWeight.Bold,
                fontSize = 18.sp
            )
        }

        HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))

        // Logs Terminal Title
        Text(
            text = "Activity Logs",
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.align(Alignment.Start).padding(bottom = 4.dp)
        )

        // Logs Terminal Box
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .background(Color.Black, shape = RoundedCornerShape(6.dp))
                .padding(8.dp)
        ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                state = listState
            ) {
                items(logs) { log ->
                    Text(
                        text = log,
                        color = Color.Green,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 11.sp,
                        modifier = Modifier.padding(vertical = 2.dp)
                    )
                }
            }
        }
    }
}

// Simple wrapper class to avoid direct array type references in functional parameters
class ActivityResultLauncherWrapper(val launch: (Array<String>) -> Unit)
