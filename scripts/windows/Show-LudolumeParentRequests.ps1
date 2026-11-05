param([Parameter(Mandatory=$true)][string]$ConfigPath, [switch]$Demo, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$reader = Join-Path (Split-Path -Parent $PSScriptRoot) 'parent-requests-reader.cjs'

function Read-LiveQueue([string]$After) {
    $containerId = $null; $dockerHost = $null; $secure = $null; $pointer = [IntPtr]::Zero; $node = $null; $privateJson = $null
    try {
        if (Get-NetTCPConnection -LocalPort $config.database.port -State Listen -ErrorAction SilentlyContinue) { throw 'A porta da consulta já está em uso. Feche a outra consulta e tente novamente.' }
        if ($env:DOCKER_HOST) { throw 'A consulta requer o Docker local, sem substituição de host.' }
        $dockerHost = (& $config.dockerPath context inspect --format '{{json .Endpoints.docker.Host}}') | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0 -or $dockerHost -notmatch '^npipe:/{4}\./pipe/[A-Za-z0-9_.-]+$') { throw 'Abra o Docker Desktop local antes de consultar.' }
        $env:CSQL_PROXY_TOKEN = & $config.gcloudPath auth print-access-token --quiet
        if ($LASTEXITCODE -ne 0 -or -not $env:CSQL_PROXY_TOKEN) { throw 'A sessão privada do Google Cloud precisa ser renovada.' }
        $containerId = & $config.dockerPath --host $dockerHost run --detach --rm --pull=never --name ('ludolume-parent-queue-'+[guid]::NewGuid().ToString('N').Substring(0,8)) --env CSQL_PROXY_TOKEN --label=com.mickeyf.purpose=parent-request-viewer --read-only --cap-drop=ALL --security-opt=no-new-privileges --memory=128m --cpus=0.5 "--publish=127.0.0.1:$($config.database.port):3306" gcr.io/cloud-sql-connectors/cloud-sql-proxy@sha256:f333a9c59890c3c67b8505166c5dbdcc0b29fca9173a2e09ca0446ab6997a736 --address=0.0.0.0 --port=3306 --max-connections=1 $config.instanceConnectionName
        $env:CSQL_PROXY_TOKEN = $null
        if ($LASTEXITCODE -ne 0 -or $containerId -notmatch '^[a-f0-9]{64}$') { throw 'Não foi possível iniciar a conexão privada.' }
        $ready = $false
        for ($attempt=0; $attempt -lt 20; $attempt++) {
            $logs = (& $config.dockerPath --host $dockerHost logs $containerId 2>&1 | Out-String)
            if ($logs.Contains('ready for new connections')) { $ready=$true; break }
            Start-Sleep -Milliseconds 300
        }
        if (-not $ready) { throw 'A conexão privada não ficou pronta.' }
        $secure = Get-Content -LiteralPath $config.passwordPath -Raw | ConvertTo-SecureString
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        $privateJson = @{password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer);after=$(if ($After) {$After} else {$null})} | ConvertTo-Json -Compress
        $start = New-Object System.Diagnostics.ProcessStartInfo
        $start.FileName = $config.nodePath
        $start.Arguments = '"' + $reader + '" "' + $ConfigPath + '"'
        $start.WorkingDirectory = $config.backendDirectory
        $start.UseShellExecute=$false; $start.CreateNoWindow=$true
        $start.RedirectStandardInput=$true; $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
        $node = New-Object System.Diagnostics.Process; $node.StartInfo=$start
        [void]$node.Start(); $output=$node.StandardOutput.ReadToEndAsync(); $errorOutput=$node.StandardError.ReadToEndAsync()
        $node.StandardInput.Write($privateJson); $node.StandardInput.Close(); $privateJson=$null
        if (-not $node.WaitForExit(60000)) { $node.Kill(); throw 'A consulta excedeu o tempo limite. Não é uma fila vazia.' }
        if ($node.ExitCode -ne 0) { throw 'Consulta indisponível. Verifique a conexão Google Cloud e a senha de operador salva; nenhuma ausência foi confirmada.' }
        return ($output.Result | ConvertFrom-Json)
    } finally {
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        if ($secure) { $secure.Dispose() }; $privateJson=$null; $env:CSQL_PROXY_TOKEN=$null
        if ($node) { if (-not $node.HasExited) { $node.Kill() }; $node.Dispose() }
        if ($containerId -match '^[a-f0-9]{64}$') {
            & $config.dockerPath --host $dockerHost stop --time=5 $containerId | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'A conexão temporária precisa ser encerrada; verifique o Docker.' }
        }
    }
}
if ($CheckOnly) {
    $result=Read-LiveQueue ''
    @{mode=$result.mode;readOnly=$result.readOnly;observedAt=$result.observedAt;requestCount=@($result.requests).Count;hasMore=($null -ne $result.nextAfter)} | ConvertTo-Json -Compress
    exit
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$form=New-Object System.Windows.Forms.Form
$form.Text='Ludolume - Solicitações pendentes'; $form.Size=New-Object System.Drawing.Size(1120,740)
$form.MinimumSize=New-Object System.Drawing.Size(900,620); $form.StartPosition='CenterScreen'
$form.Font=New-Object System.Drawing.Font('Segoe UI',10)
$layout=New-Object System.Windows.Forms.TableLayoutPanel
$layout.Dock='Fill'; $layout.ColumnCount=1; $layout.RowCount=5; $layout.Padding=New-Object System.Windows.Forms.Padding(18)
foreach ($height in @(50,48,44)) { [void]$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('Absolute',$height))) }
[void]$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('Percent',100)))
[void]$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('Absolute',170)))
$heading=New-Object System.Windows.Forms.Label; $heading.Text='Solicitações de formulário dos responsáveis'; $heading.Dock='Fill'; $heading.Font=New-Object System.Drawing.Font('Segoe UI',17,[System.Drawing.FontStyle]::Bold)
$buttons=New-Object System.Windows.Forms.FlowLayoutPanel; $buttons.Dock='Fill'
$refresh=New-Object System.Windows.Forms.Button; $refresh.Text='Atualizar fila real'; $refresh.Width=170; $refresh.Height=34
$example=New-Object System.Windows.Forms.Button; $example.Text='Ver exemplos fictícios'; $example.Width=190; $example.Height=34
$next=New-Object System.Windows.Forms.Button; $next.Text='Próxima página'; $next.Width=150; $next.Height=34; $next.Enabled=$false
$buttons.Controls.AddRange(@($refresh,$example,$next))
$status=New-Object System.Windows.Forms.Label; $status.Dock='Fill'; $status.Text='Consulta somente leitura. Clique em Atualizar fila real para consultar o banco.'
$grid=New-Object System.Windows.Forms.DataGridView; $grid.Dock='Fill'; $grid.ReadOnly=$true; $grid.AllowUserToAddRows=$false; $grid.AllowUserToDeleteRows=$false
$grid.RowHeadersVisible=$false; $grid.SelectionMode='FullRowSelect'; $grid.MultiSelect=$false; $grid.AutoSizeColumnsMode='Fill'; $grid.AutoGenerateColumns=$false
foreach ($column in @(@('reference','Número da solicitação',250),@('contact','E-mail verificado',180),@('country','País',55),@('expires','Validade',130))) {
    $col=New-Object System.Windows.Forms.DataGridViewTextBoxColumn; $col.Name=$column[0]; $col.HeaderText=$column[1]; $col.FillWeight=[float]$column[2]; [void]$grid.Columns.Add($col)
}
$details=New-Object System.Windows.Forms.TextBox; $details.Multiline=$true; $details.ReadOnly=$true; $details.Dock='Fill'; $details.ScrollBars='Vertical'
$details.Text='Selecione uma solicitação para ver as versões e instruções. Este painel consulta a fila; não aprova formulários nem envia e-mails.'
$layout.Controls.Add($heading,0,0); $layout.Controls.Add($buttons,0,1); $layout.Controls.Add($status,0,2); $layout.Controls.Add($grid,0,3); $layout.Controls.Add($details,0,4)
$form.Controls.Add($layout); $script:nextAfter=$null
function Show-Requests($Report) {
    $grid.Rows.Clear(); $script:nextAfter=$Report.nextAfter; $next.Enabled=($null -ne $script:nextAfter)
    foreach ($request in @($Report.requests)) {
        $contact=if ($request.verifiedContact) {$request.verifiedContact} else {'Indisponível - manter pendente'}
        $index=$grid.Rows.Add([string]$request.reference,[string]$contact,[string]$request.country,[string]$request.expiresAt)
        $grid.Rows[$index].Tag=$request
    }
    $mode=if ($Report.mode -eq 'demo') {'EXEMPLOS FICTÍCIOS - não são solicitações reais'} else {'FILA REAL - consulta somente leitura'}
    $status.Text="$mode | $(@($Report.requests).Count) nesta página | $($Report.observedAt)"
    if (@($Report.requests).Count -eq 0) { $details.Text='Nenhuma solicitação pendente nesta consulta. Isso não é uma aprovação nem confirmação de envio de e-mail.' }
}
function Show-Demo {
    $cases=Get-Content -LiteralPath $config.demoCasesPath -Raw | ConvertFrom-Json
    $requests=@($cases.cases | Select-Object -First 2 | ForEach-Object { [pscustomobject]@{reference=$_.reference;verifiedContact=$_.parent.contact;country=$_.country;expiresAt='Exemplo - não tem validade real';policyVersion='synthetic-operator-parent-v1';consentVersion='synthetic-not-valid-consent-v1';deliveryStatus='Não enviado';providerLinked=$true;demoFile=$_.path} })
    Show-Requests ([pscustomobject]@{mode='demo';requests=$requests;nextAfter=$null;observedAt='Treinamento'})
}
function Refresh-Queue([string]$After) {
    $refresh.Enabled=$false; $example.Enabled=$false; $next.Enabled=$false; $status.Text='Consultando pela conexão privada...'; $status.Refresh()
    try { Show-Requests (Read-LiveQueue $After) }
    catch { $grid.Rows.Clear(); $script:nextAfter=$null; $status.Text='Consulta falhou - a fila não foi confirmada.'; $details.Text=$_.Exception.Message }
    finally { $refresh.Enabled=$true; $example.Enabled=$true; $next.Enabled=($null -ne $script:nextAfter) }
}
$grid.add_SelectionChanged({
    if ($grid.SelectedRows.Count -gt 0 -and $grid.SelectedRows[0].Tag) {
        $r=$grid.SelectedRows[0].Tag
        $details.Text="Número completo: $($r.reference)`r`nE-mail verificado: $($r.verifiedContact)`r`nPaís: $($r.country)`r`nPolítica: $($r.policyVersion) | Formulário: $($r.consentVersion)`r`n`r`nCompare estes dados com o e-mail recebido e o formulário assinado. Confira a declaração, a permissão, o nome, a data e a assinatura. Se houver divergência, mantenha sem aprovação.`r`nEste painel não confirma entrega do e-mail nem aplica decisões."
        if ($r.demoFile) { $details.AppendText("`r`nArquivo fictício para comparação: $($r.demoFile)") }
    }
})
$refresh.add_Click({ Refresh-Queue '' }); $example.add_Click({ Show-Demo }); $next.add_Click({ Refresh-Queue $script:nextAfter })
$form.add_Shown({ if ($Demo) { Show-Demo }; $form.Activate() })
[void]$form.ShowDialog()
