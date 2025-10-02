import paho.mqtt.client as mqtt

UP_HOST = "mqtt.brewingremote.com"
UP_PORT = 8883
USERNAME = "bridgeuser"
PASSWORD = "bridgepass"

def on_connect(client, userdata, flags, rc, properties=None):
    if rc == 0:
        print("Connected upstream")
        client.subscribe("#")
    else:
        print("Connect failed rc=", rc)

def on_message(client, userdata, msg):
    # Here you could publish to another local broker or process
    # For illustration, just log
    print(f"{msg.topic} -> {msg.payload[:60]}")

client = mqtt.Client(client_id="bridge-client", protocol=mqtt.MQTTv311)
client.username_pw_set(USERNAME, PASSWORD)
client.tls_set()  # Uses system CA store; add cafile=... if on minimal system
client.on_connect = on_connect
client.on_message = on_message

client.connect(UP_HOST, UP_PORT, keepalive=30)
client.loop_forever()