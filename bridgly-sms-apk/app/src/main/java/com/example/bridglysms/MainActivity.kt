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
import androidx.compose.foundation.clickable
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
            Manifest.permission.READ_PHONE_NUMBERS,
            Manifest.permission.READ_SMS,
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.POST_NOTIFICATIONS,
            Manifest.permission.ACCESS_FINE_LOCATION
        )
    } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        arrayOf(
            Manifest.permission.SEND_SMS,
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.READ_PHONE_NUMBERS,
            Manifest.permission.READ_SMS,
            Manifest.permission.RECEIVE_SMS,
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
        val initialUrl = sharedPref.getString("server_url", "wss://bridgly-v5.onrender.com") ?: "wss://bridgly-v5.onrender.com"

        if (!sharedPref.contains("device_id")) {
            sharedPref.edit().putString("device_id", java.util.UUID.randomUUID().toString().take(8)).apply()
        }

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
        
        val hasPhoneState = ContextCompat.checkSelfPermission(this, Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED
        val hasPhoneNumbers = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ContextCompat.checkSelfPermission(this, Manifest.permission.READ_PHONE_NUMBERS) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
        val hasLocation = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        
        if (hasPhoneState && hasPhoneNumbers && hasLocation) {
            try {
                val list = localSubscriptionManager.activeSubscriptionInfoList
                val sharedPref = getSharedPreferences("BridglySmsConfig", Context.MODE_PRIVATE)
                val editor = sharedPref.edit()
                if (list != null && list.isNotEmpty()) {
                    editor.putBoolean("is_dual_sim", list.size > 1)
                    if (list.size > 0) {
                        editor.putInt("sim1_sub_id", list[0].subscriptionId)
                        editor.putString("sim1_carrier", list[0].carrierName?.toString() ?: "SIM 1")
                        
                        val sim1Num = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            try {
                                localSubscriptionManager.getPhoneNumber(list[0].subscriptionId) ?: ""
                            } catch (e: Exception) {
                                @Suppress("DEPRECATION")
                                list[0].number ?: ""
                            }
                        } else {
                            @Suppress("DEPRECATION")
                            list[0].number ?: ""
                        }
                        
                        editor.putString("sim1_number", sim1Num)
                        android.util.Log.i("BridglySMS", "Saved sim1_sub_id: ${list[0].subscriptionId}, number: $sim1Num")
                    } else {
                        editor.remove("sim1_sub_id")
                        editor.remove("sim1_carrier")
                        editor.remove("sim1_number")
                    }
                    if (list.size > 1) {
                        editor.putInt("sim2_sub_id", list[1].subscriptionId)
                        editor.putString("sim2_carrier", list[1].carrierName?.toString() ?: "SIM 2")
                        
                        val sim2Num = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            try {
                                localSubscriptionManager.getPhoneNumber(list[1].subscriptionId) ?: ""
                            } catch (e: Exception) {
                                @Suppress("DEPRECATION")
                                list[1].number ?: ""
                            }
                        } else {
                            @Suppress("DEPRECATION")
                            list[1].number ?: ""
                        }
                        
                        editor.putString("sim2_number", sim2Num)
                        android.util.Log.i("BridglySMS", "Saved sim2_sub_id: ${list[1].subscriptionId}, number: $sim2Num")
                    } else {
                        editor.remove("sim2_sub_id")
                        editor.remove("sim2_carrier")
                        editor.remove("sim2_number")
                    }
                } else {
                    editor.putBoolean("is_dual_sim", false)
                    editor.remove("sim1_sub_id")
                    editor.remove("sim1_carrier")
                    editor.remove("sim1_number")
                    editor.remove("sim2_sub_id")
                    editor.remove("sim2_carrier")
                    editor.remove("sim2_number")
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
    val context = LocalContext.current
    val sharedPref = remember { context.getSharedPreferences("BridglySmsConfig", Context.MODE_PRIVATE) }
    var serverUrl by remember { mutableStateOf(initialUrl) }
    var connectionState by remember { mutableStateOf(SmsService.connectionState) }
    val logs = remember { mutableStateListOf<String>().apply { addAll(SmsService.logs) } }
    var permissionsGranted by remember { mutableStateOf(checkPermissions()) }
    var showServerConfigDialog by remember { mutableStateOf(false) }
    var logsExpanded by remember { mutableStateOf(sharedPref.getBoolean("logs_expanded", true)) }
    var currentScreen by remember { mutableStateOf("dashboard") }

    // SIM info states
    var sim1Carrier by remember { mutableStateOf("SIM 1") }
    var sim1Number by remember { mutableStateOf("") }
    var sim2Carrier by remember { mutableStateOf("SIM 2") }
    var sim2Number by remember { mutableStateOf("") }
    var isDualSim by remember { mutableStateOf(false) }

    val refreshSimInfo = {
        val sharedPref = context.getSharedPreferences("BridglySmsConfig", Context.MODE_PRIVATE)
        sim1Carrier = sharedPref.getString("sim1_carrier", "SIM 1") ?: "SIM 1"
        sim1Number = sharedPref.getString("sim1_number", "") ?: ""
        sim2Carrier = sharedPref.getString("sim2_carrier", "SIM 2") ?: "SIM 2"
        sim2Number = sharedPref.getString("sim2_number", "") ?: ""
        isDualSim = sharedPref.getBoolean("is_dual_sim", false)
    }

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
        refreshSimInfo()
        SmsService.onConnectionStateChanged = {
            connectionState = SmsService.connectionState
            refreshSimInfo()
        }
        SmsService.onLogAdded = {
            logs.clear()
            logs.addAll(SmsService.logs)
        }
    }

    LaunchedEffect(permissionsGranted) {
        if (permissionsGranted) {
            refreshSimInfo()
        }
    }

    LaunchedEffect(logs.size) {
        if (logs.isNotEmpty()) {
            listState.animateScrollToItem(logs.size - 1)
        }
    }

    if (currentScreen == "direct_sms") {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .systemBarsPadding()
                .padding(16.dp),
        ) {
            // Header Row
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(bottom = 16.dp)
            ) {
                IconButton(onClick = { currentScreen = "dashboard" }) {
                    Text("⬅️", fontSize = 24.sp)
                }
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = "Direct SMS Sender",
                    fontSize = 24.sp,
                    fontWeight = FontWeight.Bold
                )
            }

            Column(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
            ) {
                // Detected SIM Cards Card
                Card(
                    modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
                    shape = RoundedCornerShape(8.dp)
                ) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Text(text = "Detected SIM Cards", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                        Spacer(modifier = Modifier.height(6.dp))
                        Text(
                            text = "SIM 1 ($sim1Carrier): " + (if (sim1Number.isNotEmpty()) sim1Number else "null"),
                            fontSize = 13.sp
                        )
                        if (isDualSim) {
                            Spacer(modifier = Modifier.height(4.dp))
                            Text(
                                text = "SIM 2 ($sim2Carrier): " + (if (sim2Number.isNotEmpty()) sim2Number else "null"),
                                fontSize = 13.sp
                            )
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
                            placeholder = { Text("60123344556") },
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
                        
                        // SIM Selection (Two Rows)
                        Column(
                            modifier = Modifier.fillMaxWidth(),
                            verticalArrangement = Arrangement.spacedBy(4.dp)
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                val sim1Text = "SIM 1" + (if (sim1Number.isNotEmpty()) " ($sim1Number)" else "")
                                RadioButton(selected = directSim == 1, onClick = { directSim = 1 })
                                Text(sim1Text, fontSize = 14.sp)
                            }
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                val sim2Text = "SIM 2" + if (isDualSim) {
                                    if (sim2Number.isNotEmpty()) " ($sim2Number)" else ""
                                } else {
                                    " (None)"
                                }
                                RadioButton(
                                    selected = directSim == 2,
                                    onClick = { directSim = 2 },
                                    enabled = isDualSim
                                )
                                Text(
                                    text = sim2Text,
                                    fontSize = 14.sp,
                                    color = if (isDualSim) MaterialTheme.colorScheme.onSurface else Color.Gray
                                )
                            }
                        }

                        Spacer(modifier = Modifier.height(8.dp))

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
                            modifier = Modifier.fillMaxWidth(),
                            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary)
                        ) {
                            Text("Send Direct")
                        }
                    }
                }
            }
        }
    } else {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .systemBarsPadding()
                .padding(16.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
                modifier = Modifier.padding(bottom = 12.dp)
            ) {
                Text(
                    text = "Bridgly SMS Gateway",
                    fontSize = 24.sp,
                    fontWeight = FontWeight.Bold
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = if (permissionsGranted) "✅" else "⚠️",
                    fontSize = 24.sp
                )
                Spacer(modifier = Modifier.width(8.dp))
                IconButton(onClick = { showServerConfigDialog = true }) {
                    Text("🌐", fontSize = 24.sp)
                }
            }

            // Connection Status
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

            // Top Scrollable Cards Area
            Column(
                modifier = Modifier
                    .weight(1.3f)
                    .fillMaxWidth()
                    .verticalScroll(scrollState)
            ) {
                // Permission Card (only shown when permissions are not fully granted)
                if (!permissionsGranted) {
                    Card(
                        modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
                        shape = RoundedCornerShape(8.dp)
                    ) {
                        Column(modifier = Modifier.padding(12.dp)) {
                            Text(
                                text = "⚠️ Permissions Required",
                                fontWeight = FontWeight.SemiBold,
                                color = Color(0xFFD32F2F)
                            )
                            Text(
                                text = "Requires Send/Read/Receive SMS, Read SIM slots, and notifications permissions.",
                                fontSize = 12.sp,
                                color = Color.Gray,
                                modifier = Modifier.padding(vertical = 4.dp)
                            )
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
                        }
                    }
                }

                // Detected SIM Cards Card
                Card(
                    modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
                    shape = RoundedCornerShape(8.dp)
                ) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Text(text = "Detected SIM Cards", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                        Spacer(modifier = Modifier.height(6.dp))
                        Text(
                            text = "SIM 1 ($sim1Carrier): " + (if (sim1Number.isNotEmpty()) sim1Number else "null"),
                            fontSize = 13.sp
                        )
                        if (isDualSim) {
                            Spacer(modifier = Modifier.height(4.dp))
                            Text(
                                text = "SIM 2 ($sim2Carrier): " + (if (sim2Number.isNotEmpty()) sim2Number else "null"),
                                fontSize = 13.sp
                            )
                        }
                    }
                }

                // Go to Direct SMS Button
                Button(
                    onClick = { currentScreen = "direct_sms" },
                    modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary),
                    shape = RoundedCornerShape(8.dp)
                ) {
                    Text("Direct SMS Sender (No Server)", modifier = Modifier.padding(vertical = 4.dp))
                }
            }

            HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))

            // Logs Terminal Title (Collapsible)
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable {
                        logsExpanded = !logsExpanded
                        sharedPref.edit().putBoolean("logs_expanded", logsExpanded).apply()
                    }
                    .padding(vertical = 6.dp)
            ) {
                Text(
                    text = "Activity Logs",
                    fontWeight = FontWeight.SemiBold
                )
                Spacer(modifier = Modifier.width(6.dp))
                Text(
                    text = if (logsExpanded) "▼" else "▶",
                    fontSize = 12.sp,
                    color = Color.Gray
                )
            }

            // Logs Terminal Box
            if (logsExpanded) {
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
    }

    if (showServerConfigDialog) {
        AlertDialog(
            onDismissRequest = { showServerConfigDialog = false },
            title = {
                Text("WebSocket Server Configuration", fontWeight = FontWeight.SemiBold, fontSize = 18.sp)
            },
            text = {
                Column(modifier = Modifier.fillMaxWidth()) {
                    OutlinedTextField(
                        value = serverUrl,
                        onValueChange = {
                            serverUrl = it
                            onSaveUrl(it)
                        },
                        label = { Text("Server WS URL") },
                        placeholder = { Text("wss://bridgly-v5.onrender.com") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true
                    )
                    Spacer(modifier = Modifier.height(12.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Button(
                            onClick = {
                                if (!permissionsGranted) {
                                    permissionsGranted = checkPermissions()
                                }
                                if (permissionsGranted) {
                                    onStartService(serverUrl)
                                    showServerConfigDialog = false
                                } else {
                                    SmsService.addLog("Connect failed: missing permissions.")
                                }
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2E7D32)),
                            modifier = Modifier.weight(1f)
                        ) {
                            Text("Connect", color = Color.White)
                        }

                        Button(
                            onClick = {
                                onStopService()
                                showServerConfigDialog = false
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFD32F2F)),
                            modifier = Modifier.weight(1f)
                        ) {
                            Text("Disconnect", color = Color.White)
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { showServerConfigDialog = false }) {
                    Text("Close")
                }
            }
        )
    }
}

// Simple wrapper class to avoid direct array type references in functional parameters
class ActivityResultLauncherWrapper(val launch: (Array<String>) -> Unit)
