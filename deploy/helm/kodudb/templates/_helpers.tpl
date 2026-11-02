{{- define "kodudb.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}{{ .Release.Name | trunc 63 | trimSuffix "-" }}{{- else -}}{{ printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}{{- end -}}
{{- end -}}

{{- define "kodudb.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "kodudb.selector" -}}
app.kubernetes.io/name: {{ .root.Chart.Name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "kodudb.image" -}}
{{ .root.Values.image.registry }}/kodudb-{{ .name }}:{{ .root.Values.image.tag | default .root.Chart.AppVersion }}
{{- end -}}

{{- define "kodudb.secretName" -}}
{{ .Values.existingSecret | default (printf "%s-secrets" (include "kodudb.fullname" .)) }}
{{- end -}}

{{/* Keeps a generated secret value across upgrades: existing value, then the configured one, then random. */}}
{{- define "kodudb.secretValue" -}}
{{- $existing := lookup "v1" "Secret" .root.Release.Namespace (printf "%s-secrets" (include "kodudb.fullname" .root)) -}}
{{- if and $existing (index ($existing.data | default dict) .key) -}}
{{ index $existing.data .key | b64dec }}
{{- else if .value -}}
{{ .value }}
{{- else if .length -}}
{{ randAlphaNum (int .length) }}
{{- end -}}
{{- end -}}

{{- define "kodudb.s3Enabled" -}}
{{- if or .Values.storage.enabled .Values.externalS3.endpoint -}}true{{- end -}}
{{- end -}}

{{- define "kodudb.apiUrl" -}}
{{- if .Values.publicUrls.api -}}{{ .Values.publicUrls.api }}
{{- else if and .Values.ingress.enabled .Values.ingress.hosts.api -}}https://{{ .Values.ingress.hosts.api }}
{{- else -}}http://localhost:{{ .Values.api.port }}{{- end -}}
{{- end -}}

{{- define "kodudb.s3Url" -}}
{{- if .Values.publicUrls.s3 -}}{{ .Values.publicUrls.s3 }}
{{- else if and .Values.ingress.enabled .Values.ingress.hosts.s3 -}}https://{{ .Values.ingress.hosts.s3 }}
{{- else if .Values.externalS3.endpoint -}}{{ .Values.externalS3.endpoint }}
{{- else -}}http://localhost:9000{{- end -}}
{{- end -}}

{{- define "kodudb.storageConsoleUrl" -}}
{{- if .Values.publicUrls.storageConsole -}}{{ .Values.publicUrls.storageConsole }}
{{- else if and .Values.ingress.enabled .Values.ingress.hosts.storageConsole -}}https://{{ .Values.ingress.hosts.storageConsole }}/rustfs/console/
{{- else if .Values.storage.enabled -}}http://localhost:9001/rustfs/console/{{- end -}}
{{- end -}}
