FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
RUN apk add --no-cache python3 util-linux e2fsprogs coreutils
COPY manager.py /usr/local/lib/vicoop-storage.py
ENTRYPOINT ["python3", "/usr/local/lib/vicoop-storage.py"]
