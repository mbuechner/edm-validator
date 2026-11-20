FROM maven:3-amazoncorretto-25 AS build

ARG SOURCE_DATE_EPOCH

WORKDIR /workspace

COPY pom.xml package.json package-lock.json ./
COPY tools ./tools
COPY src ./src

RUN if [ -n "$SOURCE_DATE_EPOCH" ]; then \
        set -- "-Dproject.build.outputTimestamp=$SOURCE_DATE_EPOCH"; \
    fi \
    && mvn -B -ntp -DskipTests verify "$@"

FROM amazoncorretto:25

ENV APP_BASE_PATH=/app/edm-validator \
    JAVA_OPTS=""

WORKDIR /app

COPY --from=build /workspace/target/edm-validator.jar ./
COPY --from=build /workspace/target/classes/META-INF/sbom/application.cdx.json ./edm-validator-sbom.json

USER 10001:10001

EXPOSE 8080

ENTRYPOINT ["sh", "-c", "set -f; exec java $JAVA_OPTS -jar /app/edm-validator.jar \"$@\"", "--"]
