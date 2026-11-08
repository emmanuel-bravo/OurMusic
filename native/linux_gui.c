#ifndef _WIN32
#include <gtk/gtk.h>
#include <gdk/gdk.h>
#include <webkit2/webkit2.h>
#include <string.h>
#include <stdio.h>

static void on_window_destroy(GtkWidget *widget, gpointer data) {
    (void)widget;
    (void)data;
    gtk_main_quit();
}

int main(int argc, char **argv) {
    const char *url = "http://127.0.0.1:4380";
    if (argc >= 2 && strncmp(argv[1], "http", 4) == 0) {
        url = argv[1];
    }

    // Permitir Wayland y X11 de forma transparente
    gdk_set_allowed_backends("wayland,x11,*");

    // Evitar fallos de sandbox bwrap / compositing / dmabuf de WebKitGTK en Wayland/X11
    g_setenv("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "1", TRUE);
    g_setenv("WEBKIT_DISABLE_COMPOSITING_MODE", "1", TRUE);
    g_setenv("WEBKIT_DISABLE_DMABUF_RENDERER", "1", TRUE);

    if (!gtk_init_check(&argc, &argv)) {
        fprintf(stderr, "[OurMusic GUI] No se pudo inicializar la pantalla gráfica (Wayland/X11).\n");
        return 1;
    }

    GtkWidget *window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_title(GTK_WINDOW(window), "OurMusic — HiFi Bit-Perfect Audio Player");
    gtk_window_set_default_size(GTK_WINDOW(window), 1340, 860);
    gtk_window_set_position(GTK_WINDOW(window), GTK_WIN_POS_CENTER);
    g_signal_connect(window, "destroy", G_CALLBACK(on_window_destroy), NULL);

    WebKitSettings *settings = webkit_settings_new();
    webkit_settings_set_enable_javascript(settings, TRUE);
    webkit_settings_set_enable_developer_extras(settings, TRUE);
    webkit_settings_set_hardware_acceleration_policy(settings, WEBKIT_HARDWARE_ACCELERATION_POLICY_NEVER);

    GtkWidget *webview = webkit_web_view_new_with_settings(settings);
    GdkRGBA bg = { 0.055, 0.059, 0.071, 1.0 };
    webkit_web_view_set_background_color(WEBKIT_WEB_VIEW(webview), &bg);

    gtk_container_add(GTK_CONTAINER(window), webview);
    webkit_web_view_load_uri(WEBKIT_WEB_VIEW(webview), url);
    gtk_widget_show_all(window);

    gtk_main();
    return 0;
}
#endif
