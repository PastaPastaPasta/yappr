#!/bin/sh
# Configure IPFS API to listen on all interfaces so other containers can connect
ipfs config Addresses.API /ip4/0.0.0.0/tcp/5001
